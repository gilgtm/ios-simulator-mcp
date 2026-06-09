#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { promisify } from "util";
import { z } from "zod";
import path from "path";
import os from "os";
import fs from "fs";

const execFileAsync = promisify(execFile);

/**
 * Strict UDID/UUID pattern: 8-4-4-4-12 hexadecimal characters (e.g. 37A360EC-75F9-4AEC-8EFA-10F4A58D8CCA)
 */
const UDID_REGEX =
  /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

const TMP_ROOT_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "ios-simulator-mcp-")
);
const DEFAULT_SWIPE_DURATION_SECONDS = "1";
const DEFAULT_SWIPE_DURATION_MS = 1000;
const SIMULATOR_PREFERENCES_PLIST = path.join(
  os.homedir(),
  "Library",
  "Preferences",
  "com.apple.iphonesimulator.plist"
);
const WDA_BUNDLE_ID = "com.facebook.WebDriverAgentRunner.xctrunner";
const WDA_REPO_URL = "https://github.com/appium/WebDriverAgent.git";
const WDA_CACHE_DIR = path.join(os.homedir(), ".ios-simulator-mcp", "wda");
const WDA_REPO_DIR = path.join(WDA_CACHE_DIR, "repo");
const WDA_DERIVED_DATA_DIR = path.join(WDA_CACHE_DIR, "DerivedData");
const WDA_APP_PATH = path.join(
  WDA_DERIVED_DATA_DIR,
  "Build",
  "Products",
  "Debug-iphonesimulator",
  "WebDriverAgentRunner-Runner.app"
);
const WDA_XCTESTRUN_PREFIX = "WebDriverAgentRunner_";
const WDA_LAUNCH_XCTESTRUN_PREFIX = "WebDriverAgentRunnerLaunch-";
const WDA_XCTESTRUN_SUFFIX = ".xctestrun";
const WDA_TEST_IDENTIFIER = "WebDriverAgentRunner/UITestingUITests/testRunner";
const WDA_BUILD_TIMEOUT_MS = 120_000;
const WDA_BUILD_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const WDA_START_TIMEOUT_MS = 30_000;
const WDA_STOP_TIMEOUT_MS = 5_000;
const WDA_TERMINATE_TIMEOUT_MS = 2_000;
const WDA_STATUS_POLL_INTERVAL_MS = 100;
const WDA_STATUS_FETCH_TIMEOUT_MS = 1_000;
const WDA_PORT_SEARCH_LIMIT = 100;
const WDA_MJPEG_PORT_OFFSET = 1000;
const MIN_WDA_PORT = 1024;
const MAX_TCP_PORT = 65535;
const MAX_WDA_PORT = MAX_TCP_PORT - WDA_MJPEG_PORT_OFFSET;
const WDA_LAUNCH_XCTESTRUN_STALE_MS = 60 * 60 * 1000;
const WDA_LOG_MAX_BYTES = 1024 * 1024;
const WDA_XCTESTRUN_ENV_PATHS = [
  "WebDriverAgentRunner.EnvironmentVariables",
  "WebDriverAgentRunner.TestingEnvironmentVariables",
] as const;
const XCODEBUILD_ENV_ALLOWLIST = [
  "ALL_PROXY",
  "DEVELOPER_DIR",
  "HOME",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "NO_PROXY",
  "PATH",
  "SDKROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "TOOLCHAINS",
  "XCODE_XCCONFIG_FILE",
  "all_proxy",
  "https_proxy",
  "http_proxy",
  "no_proxy",
] as const;
const VIDEO_CODEC_VALUES = ["h264", "hevc"] as const;
const DEFAULT_RECORDING_CODEC = "hevc";
const DEFAULT_STOP_RECORDING_SCALE = 0.5;
const DEFAULT_STOP_RECORDING_OUTPUT_CODEC = "hevc";
const parsedWdaPort = Number.parseInt(
  process.env.IOS_SIMULATOR_MCP_WDA_PORT ?? "",
  10
);
const wdaPortsByDeviceId = new Map<string, number>();
const wdaLaunchLocksByDeviceId = new Map<string, Promise<void>>();
const wdaProcessesByDeviceId = new Map<string, WdaXcodebuildProcess>();
const activeRecordingsByUdid = new Map<string, ActiveRecording>();
const recordingStartupReservationsByUdid = new Set<string>();
let wdaPortLock = Promise.resolve();
let wdaSharedDerivedDataLock = Promise.resolve();
let swiftVideoTranscodeScriptPath: string | null = null;
let isServerCleaningUp = false;
const ERROR_SUMMARY_MAX_CHARS = 300;
const RECORDING_START_TIMEOUT_MS = 3000;
const RECORDING_STOP_FINALIZATION_TIMEOUT_MS = 3000;

/**
 * Runs a command with arguments and returns the stdout and stderr
 * @param cmd - The command to run
 * @param args - The arguments to pass to the command
 * @returns The stdout and stderr of the command
 */
async function run(
  cmd: string,
  args: string[],
  options?: { env?: NodeJS.ProcessEnv; timeoutMs?: number }
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(cmd, args, {
    shell: false,
    ...(options?.env ? { env: options.env } : {}),
    ...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
  });
  return {
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  };
}

/**
 * Gets the IDB command path from environment variable or defaults to "idb"
 * @returns The path to the IDB executable
 * @throws Error if custom path is specified but doesn't exist
 */
function getIdbPath(): string {
  const customPath = process.env.IOS_SIMULATOR_MCP_IDB_PATH;

  if (customPath) {
    // Expand tilde if present
    const expandedPath = customPath.startsWith("~/")
      ? path.join(os.homedir(), customPath.slice(2))
      : customPath;

    // Check if the path exists
    if (!fs.existsSync(expandedPath)) {
      throw new Error(
        `Custom IDB path specified in IOS_SIMULATOR_MCP_IDB_PATH does not exist: ${expandedPath}`
      );
    }

    return expandedPath;
  }

  return "idb";
}

/**
 * Runs the idb command with the given arguments
 * @param args - arguments to pass to the idb command
 * @returns The stdout and stderr of the command
 * @see https://fbidb.io/docs/commands for documentation of available idb commands
 */
async function idb(...args: string[]) {
  return run(getIdbPath(), args);
}

// Read filtered tools from environment variable
const FILTERED_TOOLS =
  process.env.IOS_SIMULATOR_MCP_FILTERED_TOOLS?.split(",").map((tool) =>
    tool.trim()
  ) || [];

// Function to check if a tool is filtered
function isToolFiltered(toolName: string): boolean {
  if (
    (toolName === "ui_swipe_wda" || toolName === "ui_swipe_legacy") &&
    FILTERED_TOOLS.includes("ui_swipe")
  ) {
    return true;
  }

  return FILTERED_TOOLS.includes(toolName);
}

const server = new McpServer({
  name: "ios-simulator",
  version: require("../package.json").version,
});

function getWdaPortStart(): number {
  if (!process.env.IOS_SIMULATOR_MCP_WDA_PORT) {
    return 8100;
  }

  if (
    !/^\d+$/.test(process.env.IOS_SIMULATOR_MCP_WDA_PORT) ||
    !Number.isInteger(parsedWdaPort) ||
    parsedWdaPort < MIN_WDA_PORT ||
    parsedWdaPort > MAX_WDA_PORT
  ) {
    throw new Error(
      `IOS_SIMULATOR_MCP_WDA_PORT must be an integer from ${MIN_WDA_PORT} through ${MAX_WDA_PORT} so WebDriverAgent can bind as the current user and its MJPEG port also stays within ${MAX_TCP_PORT}`
    );
  }

  return parsedWdaPort;
}

function getWdaMjpegPort(port: number): number {
  const mjpegPort = port + WDA_MJPEG_PORT_OFFSET;
  if (mjpegPort > MAX_TCP_PORT) {
    throw new Error(
      `WebDriverAgent port ${port} leaves no valid MJPEG port; choose a port at or below ${MAX_WDA_PORT}`
    );
  }

  return mjpegPort;
}

function toError(input: unknown): Error {
  if (input instanceof Error) return input;

  if (
    typeof input === "object" &&
    input &&
    "message" in input &&
    typeof input.message === "string"
  )
    return new Error(input.message);

  return new Error(JSON.stringify(input));
}

function summarizeErrorMessage(message: string): string {
  const compactMessage = message
    .split("\n")[0]
    .split(" | stdout:")[0]
    .split(" | stderr:")[0]
    .trim();

  if (compactMessage.length <= ERROR_SUMMARY_MAX_CHARS) {
    return compactMessage;
  }

  return `${compactMessage.slice(0, ERROR_SUMMARY_MAX_CHARS - 3)}...`;
}

async function writeTempLog(prefix: string, contents: string): Promise<string> {
  const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const logPath = path.join(TMP_ROOT_DIR, `${prefix}-${uniqueSuffix}.log`);
  await fs.promises.writeFile(logPath, contents, "utf8");
  return logPath;
}

function describeCommandError(error: unknown): string {
  const baseMessage = toError(error).message;
  const details = new Set<string>();

  if (baseMessage) {
    details.add(baseMessage);
  }

  if (typeof error === "object" && error !== null) {
    if ("code" in error && typeof error.code === "number") {
      details.add(`exit code ${error.code}`);
    }

    if ("signal" in error && typeof error.signal === "string" && error.signal) {
      details.add(`signal ${error.signal}`);
    }

    if ("stdout" in error && typeof error.stdout === "string" && error.stdout.trim()) {
      details.add(`stdout: ${error.stdout.trim()}`);
    }

    if ("stderr" in error && typeof error.stderr === "string" && error.stderr.trim()) {
      details.add(`stderr: ${error.stderr.trim()}`);
    }
  }

  return Array.from(details).join(" | ");
}

function troubleshootingLink(): string {
  return "[Troubleshooting Guide](https://github.com/joshuayoes/ios-simulator-mcp/blob/main/TROUBLESHOOTING.md) | [Plain Text Guide for LLMs](https://raw.githubusercontent.com/joshuayoes/ios-simulator-mcp/refs/heads/main/TROUBLESHOOTING.md)";
}

function errorWithTroubleshooting(message: string): string {
  return `${message}\n\nFor help, see the ${troubleshootingLink()}`;
}

type BootedDevice = {
  udid: string;
  name: string;
  iosVersion: string;
};

type SimctlDevice = {
  name?: string;
  state?: string;
  udid?: string;
};

type SimctlListDevicesResponse = {
  devices?: Record<string, SimctlDevice[]>;
};

type RotationAngle = -90 | 0 | 90 | 180;
type VideoCodec = (typeof VIDEO_CODEC_VALUES)[number];

type ActiveRecording = {
  outputFile: string;
  process: ChildProcessWithoutNullStreams;
  startRotationAngle: RotationAngle | null;
  codec: VideoCodec;
};

type BootedDeviceDetails = BootedDevice & {
  runtimeIdentifier: string;
};

type UiPoint = {
  x: number;
  y: number;
};

type UiFrame = UiPoint & {
  width: number;
  height: number;
};

type UiElement = {
  AXFrame?: string | null;
  children?: UiElement[];
  frame?: UiFrame;
  [key: string]: unknown;
};

type ScreenshotFormat = "png" | "tiff" | "bmp" | "gif" | "jpeg";

type ScreenshotOptions = {
  display?: "internal" | "external";
  mask?: "ignored" | "alpha" | "black";
  type?: ScreenshotFormat;
};

type PresentationTransform = {
  presentedHeight: number;
  presentedWidth: number;
  rawHeight: number;
  rawWidth: number;
  rotationAngle: RotationAngle;
};

type SimulatorDevicePreferences = {
  SimulatorWindowOrientation?: string;
  SimulatorWindowRotationAngle?: number;
};

type SimulatorHardwareButton = {
  position: [number, number];
  size: [number, number];
};

type SimulatorWindowOrientationSignal = {
  sleepWake: SimulatorHardwareButton | null;
  volumeDown: SimulatorHardwareButton | null;
  volumeUp: SimulatorHardwareButton | null;
  windowPosition: [number, number];
  windowSize: [number, number];
};

type WdaStatusResponse = {
  value?: {
    ready?: boolean;
  };
};

type WdaLaunchResult =
  | {
      ok: true;
    }
  | {
      ok: false;
      reason: string;
    };

type WdaXcodebuildProcess = {
  closed: boolean;
  logPath: string;
  port: number;
  process: ChildProcessWithoutNullStreams;
  resultBundlePath: string;
  xctestrunPath: string;
};

type BoundedLogState = {
  bytesWritten: number;
  truncated: boolean;
};

type WdaPortForSwipeResult =
  | {
      port: number;
    }
  | {
      port: null;
      reason: string;
    };

type OrientationProbe = {
  frame: UiFrame;
  label: string | null;
  point: UiPoint;
};

type VideoPostProcessMethod = "ffmpeg" | "swift";

type VideoPostProcessResult = {
  applied: boolean;
  changes: string[];
  outputCodec: VideoCodec;
  method?: VideoPostProcessMethod;
  note?: string;
};

const ROTATION_ANGLE_CANDIDATES: RotationAngle[] = [0, 90, -90, 180];
const ORIENTATION_INFERENCE_PROBE_LIMIT = 8;
const ORIENTATION_INFERENCE_QUICK_PROBE_LIMIT = 3;
const presentationRotationCacheByDeviceId = new Map<
  string,
  { rotationAngle: RotationAngle; signature: string }
>();
function isBootedDevice(
  device: SimctlDevice
): device is SimctlDevice & { name: string; state: "Booted"; udid: string } {
  return (
    device.state === "Booted" &&
    typeof device.name === "string" &&
    typeof device.udid === "string"
  );
}

async function getBootedDevices(): Promise<BootedDevice[]> {
  const { stdout, stderr } = await run("xcrun", [
    "simctl",
    "list",
    "devices",
    "--json",
  ]);

  if (stderr) throw new Error(stderr);

  const devices = (JSON.parse(stdout) as SimctlListDevicesResponse).devices ?? {};
  const bootedDevices = Object.entries(devices).flatMap(
    ([runtimeIdentifier, runtimeDevices]) => {
      const iosVersion = parseSimulatorRuntimeIdentifier(runtimeIdentifier)?.version
        ?? runtimeIdentifier;

      return runtimeDevices.filter(isBootedDevice).map((device) => ({
        udid: device.udid,
        name: device.name,
        iosVersion,
      }));
    }
  );

  if (bootedDevices.length === 0) {
    throw Error("No booted simulator found");
  }

  return bootedDevices;
}

async function getBootedDeviceDetails(
  deviceId: string
): Promise<BootedDeviceDetails> {
  const normalizedDeviceId = deviceId.toUpperCase();
  const { stdout, stderr } = await run("xcrun", [
    "simctl",
    "list",
    "devices",
    "--json",
  ]);

  if (stderr) throw new Error(stderr);

  const devices = (JSON.parse(stdout) as SimctlListDevicesResponse).devices ?? {};
  for (const [runtimeIdentifier, runtimeDevices] of Object.entries(devices)) {
    for (const runtimeDevice of runtimeDevices) {
      if (
        runtimeDevice.udid?.toUpperCase() === normalizedDeviceId &&
        typeof runtimeDevice.name === "string"
      ) {
        return {
          udid: runtimeDevice.udid ?? normalizedDeviceId,
          name: runtimeDevice.name,
          iosVersion:
            parseSimulatorRuntimeIdentifier(runtimeIdentifier)?.version ??
            runtimeIdentifier,
          runtimeIdentifier,
        };
      }
    }
  }

  throw new Error(`Could not find simulator details for device ${deviceId}`);
}

function isUiPoint(value: unknown): value is UiPoint {
  return (
    typeof value === "object" &&
    value !== null &&
    "x" in value &&
    typeof value.x === "number" &&
    "y" in value &&
    typeof value.y === "number"
  );
}

function isUiFrame(value: unknown): value is UiFrame {
  return (
    isUiPoint(value) &&
    "width" in value &&
    typeof value.width === "number" &&
    "height" in value &&
    typeof value.height === "number"
  );
}

function normalizeRotationAngle(
  rotationAngle: unknown,
  orientation: unknown
): RotationAngle {
  const numericAngle = Number(rotationAngle);
  if (Number.isFinite(numericAngle)) {
    const normalizedAngle = ((((0 - numericAngle) % 360) + 540) % 360) - 180;
    const roundedAngle = Math.round(normalizedAngle / 90) * 90;
    if (
      Math.abs(normalizedAngle - roundedAngle) < 0.0001 &&
      (roundedAngle === 0 ||
        roundedAngle === 90 ||
        roundedAngle === -90 ||
        roundedAngle === 180 ||
        roundedAngle === -180)
    ) {
      return roundedAngle === -180 ? 180 : (roundedAngle as RotationAngle);
    }
  }

  switch (orientation) {
    case "LandscapeLeft":
      return -90;
    case "LandscapeRight":
      return 90;
    case "PortraitUpsideDown":
      return 180;
    default:
      return 0;
  }
}

function parseSimulatorRuntimeIdentifier(
  runtimeIdentifier: string
): { platform: string; version: string } | null {
  const match = runtimeIdentifier.match(/SimRuntime\.([A-Za-z]+)-(.+)$/);
  if (!match) {
    return null;
  }

  return {
    platform: match[1],
    version: match[2].replace(/-/g, "."),
  };
}

function formatSimulatorRuntimeTitle(runtimeIdentifier: string): string {
  const runtime = parseSimulatorRuntimeIdentifier(runtimeIdentifier);
  if (!runtime) {
    return runtimeIdentifier;
  }

  return `${runtime.platform} ${runtime.version}`;
}

async function getSimulatorDevicePreferences(
  deviceId: string
): Promise<SimulatorDevicePreferences> {
  try {
    const { stdout } = await run("plutil", [
      "-extract",
      `DevicePreferences.${deviceId}`,
      "json",
      "-o",
      "-",
      SIMULATOR_PREFERENCES_PLIST,
    ]);
    return JSON.parse(stdout) as SimulatorDevicePreferences;
  } catch {
    return {};
  }
}

function getExpectedSimulatorWindowTitle(
  deviceDetails: BootedDeviceDetails
): string {
  return `${deviceDetails.name} \u2013 ${formatSimulatorRuntimeTitle(
    deviceDetails.runtimeIdentifier
  )}`;
}

async function getSimulatorWindowOrientationSignal(
  deviceId: string
): Promise<SimulatorWindowOrientationSignal | null> {
  try {
    const deviceDetails = await getBootedDeviceDetails(deviceId);
    const expectedTitle = getExpectedSimulatorWindowTitle(deviceDetails);
    const expectedNamePrefix = `${deviceDetails.name} \u2013 `;
    const jxaScript = `
const expectedTitle = ${JSON.stringify(expectedTitle)};
const expectedNamePrefix = ${JSON.stringify(expectedNamePrefix)};
const se = Application("System Events");
const proc = se.processes.byName("Simulator");

function findWindow() {
  const windows = proc.windows();
  for (const win of windows) {
    const name = win.name();
    if (name === expectedTitle) {
      return win;
    }
  }
  for (const win of windows) {
    const name = win.name();
    if (name.startsWith(expectedNamePrefix)) {
      return win;
    }
  }
  if (windows.length === 1) {
    return windows[0];
  }
  return null;
}

function maybeButton(win, names) {
  for (const name of names) {
    try {
      const button = win.buttons.byName(name);
      return {
        position: button.position(),
        size: button.size(),
      };
    } catch {}
  }
  return null;
}

const win = findWindow();
if (!win) {
  throw new Error("Simulator window not found");
}

console.log(JSON.stringify({
  windowPosition: win.position(),
  windowSize: win.size(),
  volumeUp: maybeButton(win, ["Volume Up"]),
  volumeDown: maybeButton(win, ["Volume Down"]),
  sleepWake: maybeButton(win, ["Sleep/Wake", "Side Button", "Action"]),
}));
`;

    const { stdout } = await run("osascript", [
      "-l",
      "JavaScript",
      "-e",
      jxaScript,
    ]);
    return JSON.parse(stdout) as SimulatorWindowOrientationSignal;
  } catch {
    return null;
  }
}

function getButtonCenter(button: SimulatorHardwareButton): UiPoint {
  return {
    x: button.position[0] + button.size[0] / 2,
    y: button.position[1] + button.size[1] / 2,
  };
}

function getRotationAngleFromWindowSignal(
  signal: SimulatorWindowOrientationSignal
): RotationAngle | null {
  if (!signal.volumeUp || !signal.volumeDown) {
    return null;
  }

  const [windowX, windowY] = signal.windowPosition;
  const [windowWidth, windowHeight] = signal.windowSize;
  const volumeUpCenter = getButtonCenter(signal.volumeUp);
  const volumeDownCenter = getButtonCenter(signal.volumeDown);
  const volumeDx = Math.abs(volumeUpCenter.x - volumeDownCenter.x);
  const volumeDy = Math.abs(volumeUpCenter.y - volumeDownCenter.y);
  const averageVolumeX =
    (volumeUpCenter.x + volumeDownCenter.x) / 2 - windowX;
  const averageVolumeY =
    (volumeUpCenter.y + volumeDownCenter.y) / 2 - windowY;

  if (volumeDy >= volumeDx) {
    return averageVolumeX >= windowWidth / 2 ? 0 : 180;
  }

  return averageVolumeY >= windowHeight / 2 ? 90 : -90;
}

async function getPresentedRotationAngle(deviceId: string): Promise<RotationAngle> {
  const signal = await getSimulatorWindowOrientationSignal(deviceId);
  const buttonDerivedRotation = signal
    ? getRotationAngleFromWindowSignal(signal)
    : null;

  if (buttonDerivedRotation !== null) {
    return buttonDerivedRotation;
  }

  const preferences = await getSimulatorDevicePreferences(deviceId);
  return normalizeRotationAngle(
    preferences.SimulatorWindowRotationAngle,
    preferences.SimulatorWindowOrientation
  );
}

function getUiRootFrame(uiData: UiElement[]): UiFrame {
  const rootFrame = uiData[0]?.frame;
  if (!isUiFrame(rootFrame)) {
    throw new Error("Could not determine screen dimensions");
  }
  return rootFrame;
}

async function getPresentedUiData(deviceId: string): Promise<UiElement[]> {
  const { stdout } = await idb(
    "ui",
    "describe-all",
    "--udid",
    deviceId,
    "--json",
    "--nested"
  );

  const uiData = JSON.parse(stdout);
  if (!Array.isArray(uiData) || uiData.length === 0) {
    throw new Error("Could not determine screen dimensions");
  }

  return uiData as UiElement[];
}

function createPresentationTransform(
  presentedRootFrame: UiFrame,
  rotationAngle: RotationAngle
): PresentationTransform {
  const isQuarterTurn = Math.abs(rotationAngle) === 90;

  return {
    rotationAngle,
    rawWidth: isQuarterTurn
      ? presentedRootFrame.height
      : presentedRootFrame.width,
    rawHeight: isQuarterTurn
      ? presentedRootFrame.width
      : presentedRootFrame.height,
    presentedWidth: presentedRootFrame.width,
    presentedHeight: presentedRootFrame.height,
  };
}

function pointInFrame(point: UiPoint, frame: UiFrame): boolean {
  return (
    point.x >= frame.x &&
    point.x <= frame.x + frame.width &&
    point.y >= frame.y &&
    point.y <= frame.y + frame.height
  );
}

function framesApproximatelyEqual(
  left: UiFrame,
  right: UiFrame,
  epsilon = 1
): boolean {
  return (
    Math.abs(left.x - right.x) <= epsilon &&
    Math.abs(left.y - right.y) <= epsilon &&
    Math.abs(left.width - right.width) <= epsilon &&
    Math.abs(left.height - right.height) <= epsilon
  );
}

function collectOrientationProbeElements(
  elements: UiElement[],
  rootFrame: UiFrame
): OrientationProbe[] {
  const probes: Array<OrientationProbe & { score: number }> = [];
  const rootArea = rootFrame.width * rootFrame.height;
  const rootCenterX = rootFrame.x + rootFrame.width / 2;
  const rootCenterY = rootFrame.y + rootFrame.height / 2;

  function visit(element: UiElement, isRoot = false): void {
    if (isUiFrame(element.frame)) {
      const area = element.frame.width * element.frame.height;
      if (
        !isRoot &&
        area > 0 &&
        area < rootArea * 0.9 &&
        element.frame.width > 4 &&
        element.frame.height > 4
      ) {
        const point = {
          x: element.frame.x + element.frame.width / 2,
          y: element.frame.y + element.frame.height / 2,
        };
        const normalizedDistanceFromCenter =
          Math.abs(point.x - rootCenterX) / Math.max(rootFrame.width, 1) +
          Math.abs(point.y - rootCenterY) / Math.max(rootFrame.height, 1);
        probes.push({
          frame: element.frame,
          label: typeof element.AXLabel === "string" ? element.AXLabel : null,
          point,
          score:
            normalizedDistanceFromCenter +
            1 / Math.sqrt(Math.max(area, 1)),
        });
      }
    }

    if (Array.isArray(element.children)) {
      for (const child of element.children) {
        visit(child);
      }
    }
  }

  elements.forEach((element, index) => visit(element, index === 0));

  return probes
    .sort(
      (left, right) => right.score - left.score
    )
    .filter((probe, index, allProbes) => {
      const roundedPoint = roundUiPoint(probe.point);
      return (
        allProbes.findIndex((candidate) => {
          const roundedCandidate = roundUiPoint(candidate.point);
          return (
            roundedCandidate.x === roundedPoint.x &&
            roundedCandidate.y === roundedPoint.y
          );
        }) === index
      );
    })
    .slice(0, ORIENTATION_INFERENCE_PROBE_LIMIT)
    .map(({ score: _score, ...probe }) => probe);
}

async function describeRawPoint(
  deviceId: string,
  rawPoint: UiPoint
): Promise<UiElement> {
  const { stdout, stderr } = await idb(
    "ui",
    "describe-point",
    "--udid",
    deviceId,
    "--json",
    "--",
    String(rawPoint.x),
    String(rawPoint.y)
  );

  if (stderr) {
    throw new Error(stderr);
  }

  return JSON.parse(stdout) as UiElement;
}

function getRotationAngleCandidatesForRootFrame(
  presentedRootFrame: UiFrame
): RotationAngle[] {
  if (presentedRootFrame.width > presentedRootFrame.height) {
    return [90, -90];
  }

  if (presentedRootFrame.height > presentedRootFrame.width) {
    return [0, 180];
  }

  return ROTATION_ANGLE_CANDIDATES;
}

function scoreProbeMatch(
  describedElement: UiElement,
  probe: OrientationProbe
): 0 | 1 | 2 {
  if (!isUiFrame(describedElement.frame)) {
    return 0;
  }

  if (framesApproximatelyEqual(describedElement.frame, probe.frame)) {
    return 2;
  }

  if (pointInFrame(probe.point, describedElement.frame)) {
    return 1;
  }

  return 0;
}

function getPresentationSignature(
  presentedRootFrame: UiFrame,
  probes: OrientationProbe[]
): string {
  return JSON.stringify({
    rootFrame: presentedRootFrame,
    probes: probes.slice(0, 3).map((probe) => ({
      frame: probe.frame,
      label: probe.label,
    })),
  });
}

async function inferRotationAngleFromUiQuick(
  deviceId: string,
  presentedRootFrame: UiFrame,
  probes: OrientationProbe[],
  rotationAngles: RotationAngle[]
): Promise<RotationAngle | null> {
  let remainingAngles = [...rotationAngles];

  for (const probe of probes.slice(0, ORIENTATION_INFERENCE_QUICK_PROBE_LIMIT)) {
    const candidateScores = await Promise.all(
      remainingAngles.map(async (rotationAngle) => {
        const transform = createPresentationTransform(
          presentedRootFrame,
          rotationAngle
        );
        const describedElement = await describeRawPoint(
          deviceId,
          roundUiPoint(transformPointToRaw(probe.point, transform))
        );

        return {
          rotationAngle,
          score: scoreProbeMatch(describedElement, probe),
        };
      })
    );

    const bestScore = Math.max(...candidateScores.map((candidate) => candidate.score));
    if (bestScore <= 0) {
      continue;
    }

    const bestAngles = candidateScores
      .filter((candidate) => candidate.score === bestScore)
      .map((candidate) => candidate.rotationAngle);

    if (bestAngles.length === 1) {
      return bestAngles[0];
    }

    remainingAngles = bestAngles;
  }

  return remainingAngles.length === 1 ? remainingAngles[0] : null;
}

async function inferRotationAngleFromUiExhaustive(
  deviceId: string,
  presentedRootFrame: UiFrame,
  probes: OrientationProbe[],
  rotationAngles: RotationAngle[]
): Promise<RotationAngle | null> {
  let bestRotation: RotationAngle | null = null;
  let bestScore = -1;
  let hasTie = false;

  for (const rotationAngle of rotationAngles) {
    const transform = createPresentationTransform(
      presentedRootFrame,
      rotationAngle
    );
    let score = 0;

    for (const probe of probes) {
      try {
        const describedElement = await describeRawPoint(
          deviceId,
          roundUiPoint(transformPointToRaw(probe.point, transform))
        );
        score += scoreProbeMatch(describedElement, probe);
      } catch {
        // Ignore individual probe failures and rely on the remaining probes.
      }
    }

    if (score > bestScore) {
      bestRotation = rotationAngle;
      bestScore = score;
      hasTie = false;
    } else if (score === bestScore) {
      hasTie = true;
    }
  }

  if (bestRotation === null || bestScore <= 0 || hasTie) {
    return null;
  }

  return bestRotation;
}

async function inferRotationAngleFromUi(
  deviceId: string,
  presentedRootFrame: UiFrame,
  probes: OrientationProbe[]
): Promise<RotationAngle | null> {
  if (probes.length === 0) {
    return null;
  }
  const candidateAngles = getRotationAngleCandidatesForRootFrame(
    presentedRootFrame
  );
  const cachedRotation =
    presentationRotationCacheByDeviceId.get(deviceId)?.rotationAngle;
  const orderedCandidateAngles =
    cachedRotation !== undefined && candidateAngles.includes(cachedRotation)
      ? [
          cachedRotation,
          ...candidateAngles.filter((rotationAngle) => rotationAngle !== cachedRotation),
        ]
      : candidateAngles;

  const quickRotation = await inferRotationAngleFromUiQuick(
    deviceId,
    presentedRootFrame,
    probes,
    orderedCandidateAngles
  );
  if (quickRotation !== null) {
    return quickRotation;
  }

  return inferRotationAngleFromUiExhaustive(
    deviceId,
    presentedRootFrame,
    probes,
    orderedCandidateAngles
  );
}

async function getPresentationTransform(
  deviceId: string,
  presentedUiData: UiElement[]
): Promise<PresentationTransform> {
  const presentedRootFrame = getUiRootFrame(presentedUiData);
  const probes = collectOrientationProbeElements(presentedUiData, presentedRootFrame);
  const signature = getPresentationSignature(presentedRootFrame, probes);
  const cachedEntry = presentationRotationCacheByDeviceId.get(deviceId);
  if (cachedEntry?.signature === signature) {
    return createPresentationTransform(
      presentedRootFrame,
      cachedEntry.rotationAngle
    );
  }

  const inferredRotation = probes.length
    ? await inferRotationAngleFromUi(deviceId, presentedRootFrame, probes)
    : null;
  const rotationAngle =
    inferredRotation ?? (await getPresentedRotationAngle(deviceId));

  presentationRotationCacheByDeviceId.set(deviceId, {
    rotationAngle,
    signature,
  });

  return createPresentationTransform(presentedRootFrame, rotationAngle);
}

async function getUiInteractionContext(deviceId: string): Promise<{
  presentedUiData: UiElement[];
  transform: PresentationTransform;
}> {
  const presentedUiData = await getPresentedUiData(deviceId);
  const transform = await getPresentationTransform(deviceId, presentedUiData);

  return {
    transform,
    presentedUiData,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function transformPointToRaw(
  point: UiPoint,
  transform: PresentationTransform
): UiPoint {
  switch (transform.rotationAngle) {
    case 90:
      return {
        x: clamp(point.y, 0, transform.rawWidth),
        y: clamp(transform.rawHeight - point.x, 0, transform.rawHeight),
      };
    case -90:
      return {
        x: clamp(transform.rawWidth - point.y, 0, transform.rawWidth),
        y: clamp(point.x, 0, transform.rawHeight),
      };
    case 180:
      return {
        x: clamp(transform.rawWidth - point.x, 0, transform.rawWidth),
        y: clamp(transform.rawHeight - point.y, 0, transform.rawHeight),
      };
    default:
      return {
        x: clamp(point.x, 0, transform.rawWidth),
        y: clamp(point.y, 0, transform.rawHeight),
      };
  }
}

function roundUiPoint(point: UiPoint): UiPoint {
  return {
    x: Math.round(point.x),
    y: Math.round(point.y),
  };
}

function createTempFilePath(prefix: string, extension: string): string {
  return path.join(
    TMP_ROOT_DIR,
    `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}.${extension}`
  );
}

function createSiblingTempFilePath(filePath: string, label: string): string {
  const extension = path.extname(filePath);
  const baseName = extension ? path.basename(filePath, extension) : path.basename(filePath);

  return path.join(
    path.dirname(filePath),
    `${baseName}.${label}-${Date.now()}-${Math.random().toString(16).slice(2)}${extension}`
  );
}

async function commandExists(commandName: string): Promise<boolean> {
  try {
    await run("which", [commandName]);
    return true;
  } catch {
    return false;
  }
}

function getFfmpegRotationFilter(rotationAngle: RotationAngle): string | null {
  switch (rotationAngle) {
    case 90:
      return "transpose=clock";
    case -90:
      return "transpose=cclock";
    case 180:
      return "hflip,vflip";
    default:
      return null;
  }
}

function getFfmpegScaleFilter(scale: number): string | null {
  if (scale === 1) {
    return null;
  }

  const scaleFactor = String(scale);
  return `scale=ceil(iw*${scaleFactor}/2)*2:ceil(ih*${scaleFactor}/2)*2`;
}

function getFfmpegVideoFilter(
  rotationAngle: RotationAngle,
  scale: number
): string | null {
  const filters = [
    getFfmpegRotationFilter(rotationAngle),
    getFfmpegScaleFilter(scale),
  ].filter((filter): filter is string => filter !== null);

  return filters.length > 0 ? filters.join(",") : null;
}

function getFfmpegVideoCodecArgs(codec: VideoCodec): string[] {
  if (codec === "hevc") {
    return ["-c:v", "libx265", "-tag:v", "hvc1", "-crf", "18"];
  }

  return ["-c:v", "libx264", "-crf", "18"];
}

function describeVideoCodec(codec: VideoCodec): string {
  return codec === "hevc" ? "HEVC/H.265" : "H.264";
}

function formatScalePercentage(scale: number): string {
  const percentage = Number((scale * 100).toFixed(2));
  return Number.isInteger(percentage) ? percentage.toFixed(0) : String(percentage);
}

function describeVideoPostProcessChanges(
  rotationApplied: boolean,
  scale: number,
  sourceCodec: VideoCodec,
  outputCodec: VideoCodec
): string[] {
  const changes: string[] = [];

  if (rotationApplied) {
    changes.push("baked the simulator's displayed orientation");
  }

  if (scale !== 1) {
    changes.push(`scaled the video to ${formatScalePercentage(scale)}%`);
  }

  if (outputCodec !== sourceCodec) {
    changes.push(`encoded the video as ${describeVideoCodec(outputCodec)}`);
  }

  return changes;
}

function combineNotes(...notes: Array<string | undefined>): string | undefined {
  const presentNotes = notes.filter(
    (note): note is string => typeof note === "string" && note.length > 0
  );

  return presentNotes.length > 0 ? presentNotes.join("\n") : undefined;
}

const SWIFT_VIDEO_TRANSCODE_SCRIPT = String.raw`import Foundation
import AVFoundation
import CoreGraphics

func usage() -> Never {
  fputs("usage: transcode-video.swift <input> <output> <angle> <scale> <codec>\n", stderr)
  exit(2)
}

func scaledDimension(_ value: CGFloat, scale: Double) -> CGFloat {
  let scaledValue = value * scale
  return max(2, floor(scaledValue / 2) * 2)
}

guard CommandLine.arguments.count == 6 else { usage() }
let inputURL = URL(fileURLWithPath: CommandLine.arguments[1])
let outputURL = URL(fileURLWithPath: CommandLine.arguments[2])
guard let angle = Int(CommandLine.arguments[3]) else { usage() }
guard let scale = Double(CommandLine.arguments[4]), scale.isFinite, scale > 0 else { usage() }
let codec = CommandLine.arguments[5]

let asset = AVURLAsset(url: inputURL)
let composition = AVMutableComposition()

guard let videoTrack = asset.tracks(withMediaType: .video).first else {
  throw NSError(domain: "TranscodeVideo", code: 1, userInfo: [NSLocalizedDescriptionKey: "Missing video track"])
}

guard let compositionVideoTrack = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else {
  throw NSError(domain: "TranscodeVideo", code: 2, userInfo: [NSLocalizedDescriptionKey: "Could not create video track"])
}

let duration = asset.duration
try compositionVideoTrack.insertTimeRange(CMTimeRange(start: .zero, duration: duration), of: videoTrack, at: .zero)
compositionVideoTrack.preferredTransform = .identity

if let audioTrack = asset.tracks(withMediaType: .audio).first,
   let compositionAudioTrack = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) {
  try compositionAudioTrack.insertTimeRange(CMTimeRange(start: .zero, duration: duration), of: audioTrack, at: .zero)
}

let naturalSize = videoTrack.naturalSize
let videoComposition = AVMutableVideoComposition()
let nominalFrameRate = videoTrack.nominalFrameRate
videoComposition.frameDuration = nominalFrameRate > 0
  ? CMTime(value: 1, timescale: CMTimeScale(nominalFrameRate.rounded()))
  : CMTime(value: 1, timescale: 30)

let instruction = AVMutableVideoCompositionInstruction()
instruction.timeRange = CMTimeRange(start: .zero, duration: duration)
let layerInstruction = AVMutableVideoCompositionLayerInstruction(assetTrack: compositionVideoTrack)

let baseRenderSize: CGSize
let baseTransform: CGAffineTransform
switch angle {
case 90:
  baseRenderSize = CGSize(width: naturalSize.height, height: naturalSize.width)
  baseTransform = CGAffineTransform(translationX: naturalSize.height, y: 0).rotated(by: .pi / 2)
case -90:
  baseRenderSize = CGSize(width: naturalSize.height, height: naturalSize.width)
  baseTransform = CGAffineTransform(translationX: 0, y: naturalSize.width).rotated(by: -.pi / 2)
case 180:
  baseRenderSize = CGSize(width: naturalSize.width, height: naturalSize.height)
  baseTransform = CGAffineTransform(translationX: naturalSize.width, y: naturalSize.height).rotated(by: .pi)
case 0:
  baseRenderSize = naturalSize
  baseTransform = .identity
default:
  throw NSError(domain: "TranscodeVideo", code: 3, userInfo: [NSLocalizedDescriptionKey: "Unsupported angle \(angle)"])
}

let scaledRenderSize = CGSize(
  width: scaledDimension(baseRenderSize.width, scale: scale),
  height: scaledDimension(baseRenderSize.height, scale: scale)
)
videoComposition.renderSize = scaledRenderSize

let scaleTransform = CGAffineTransform(
  scaleX: scaledRenderSize.width / baseRenderSize.width,
  y: scaledRenderSize.height / baseRenderSize.height
)
let transform = baseTransform.concatenating(scaleTransform)

let requestedPresetName: String
switch codec {
case "hevc":
  requestedPresetName = AVAssetExportPresetHEVCHighestQuality
case "h264":
  requestedPresetName = AVAssetExportPresetHighestQuality
default:
  usage()
}

let actualCodec = codec
let presetName = requestedPresetName
var codecFallbackNote: String?

if codec == "hevc" {
  let compatiblePresets = AVAssetExportSession.exportPresets(compatibleWith: composition)
  if !compatiblePresets.contains(AVAssetExportPresetHEVCHighestQuality) {
    actualCodec = "h264"
    presetName = AVAssetExportPresetHighestQuality
    codecFallbackNote = "HEVC export is not supported on this Mac, so the built-in macOS video exporter fell back to H.264."
  }
}

layerInstruction.setTransform(transform, at: .zero)
instruction.layerInstructions = [layerInstruction]
videoComposition.instructions = [instruction]

if FileManager.default.fileExists(atPath: outputURL.path) {
  try FileManager.default.removeItem(at: outputURL)
}

guard let exportSession = AVAssetExportSession(asset: composition, presetName: presetName) else {
  throw NSError(domain: "TranscodeVideo", code: 4, userInfo: [NSLocalizedDescriptionKey: "Could not create export session"])
}
exportSession.outputURL = outputURL
exportSession.outputFileType = .mp4
exportSession.shouldOptimizeForNetworkUse = true
exportSession.videoComposition = videoComposition

let semaphore = DispatchSemaphore(value: 0)
var exportError: Error?
exportSession.exportAsynchronously {
  exportError = exportSession.error
  semaphore.signal()
}
semaphore.wait()

if let exportError {
  throw exportError
}
if exportSession.status != .completed {
  throw NSError(domain: "TranscodeVideo", code: 5, userInfo: [NSLocalizedDescriptionKey: "Export failed with status \(exportSession.status.rawValue)"])
}

let result: [String: String] = {
  var value = ["outputCodec": actualCodec]
  if let codecFallbackNote {
    value["note"] = codecFallbackNote
  }
  return value
}()
let jsonData = try JSONSerialization.data(withJSONObject: result, options: [])
guard let json = String(data: jsonData, encoding: .utf8) else {
  throw NSError(domain: "TranscodeVideo", code: 6, userInfo: [NSLocalizedDescriptionKey: "Could not encode export result"])
}
print(json)
`;

async function getSwiftVideoTranscodeScriptPath(): Promise<string> {
  if (swiftVideoTranscodeScriptPath) {
    return swiftVideoTranscodeScriptPath;
  }

  const scriptPath = createTempFilePath("transcode-video", "swift");
  await fs.promises.writeFile(scriptPath, SWIFT_VIDEO_TRANSCODE_SCRIPT, "utf8");
  swiftVideoTranscodeScriptPath = scriptPath;

  return scriptPath;
}

async function transcodeRecordedVideoWithFfmpeg(
  inputPath: string,
  outputPath: string,
  rotationAngle: RotationAngle,
  scale: number,
  outputCodec: VideoCodec
): Promise<void> {
  const filter = getFfmpegVideoFilter(rotationAngle, scale);

  await run("ffmpeg", [
    "-y",
    "-nostdin",
    "-v",
    "error",
    "-i",
    inputPath,
    ...(filter ? ["-vf", filter] : []),
    ...getFfmpegVideoCodecArgs(outputCodec),
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "copy",
    "-movflags",
    "+faststart",
    outputPath,
  ]);
}

async function transcodeRecordedVideoWithSwift(
  inputPath: string,
  outputPath: string,
  rotationAngle: RotationAngle,
  scale: number,
  outputCodec: VideoCodec
): Promise<{ outputCodec: VideoCodec; note?: string }> {
  const scriptPath = await getSwiftVideoTranscodeScriptPath();
  const { stdout } = await run("xcrun", [
    "swift",
    scriptPath,
    inputPath,
    outputPath,
    String(rotationAngle),
    String(scale),
    outputCodec,
  ]);

  if (!stdout) {
    return { outputCodec };
  }

  return JSON.parse(stdout) as { outputCodec: VideoCodec; note?: string };
}

async function replaceFileWithTempOutput(
  tempOutputPath: string,
  finalOutputPath: string
): Promise<void> {
  const backupPath = createSiblingTempFilePath(finalOutputPath, "backup");
  let originalMoved = false;

  try {
    await fs.promises.rename(finalOutputPath, backupPath);
    originalMoved = true;
    await fs.promises.rename(tempOutputPath, finalOutputPath);
    await fs.promises.unlink(backupPath).catch(() => {});
    originalMoved = false;
  } finally {
    await fs.promises.unlink(tempOutputPath).catch(() => {});

    if (originalMoved) {
      await fs.promises.rename(backupPath, finalOutputPath).catch(() => {});
      await fs.promises.unlink(backupPath).catch(() => {});
    }
  }
}

async function getRecordingStartRotationAngle(
  deviceId: string
): Promise<RotationAngle | null> {
  try {
    const { transform } = await getUiInteractionContext(deviceId);
    return transform.rotationAngle;
  } catch {
    return null;
  }
}

async function postProcessRecordedVideo(
  outputFile: string,
  startRotationAngle: RotationAngle | null,
  options: {
    fixRotation: boolean;
    outputCodec: VideoCodec;
    scale: number;
    sourceCodec: VideoCodec;
  }
): Promise<VideoPostProcessResult> {
  const rotationNote =
    options.fixRotation && startRotationAngle === null
      ? "Rotation fix was skipped because the simulator orientation could not be determined when recording started."
      : undefined;
  const rotationAngle =
    options.fixRotation && startRotationAngle !== null ? startRotationAngle : 0;
  const getChanges = (actualOutputCodec: VideoCodec) =>
    describeVideoPostProcessChanges(
      rotationAngle !== 0,
      options.scale,
      options.sourceCodec,
      actualOutputCodec
    );
  const requestedChanges = getChanges(options.outputCodec);

  if (requestedChanges.length === 0) {
    return {
      applied: false,
      changes: requestedChanges,
      outputCodec: options.outputCodec,
      note: rotationNote,
    };
  }

  const tempOutputPath = createSiblingTempFilePath(outputFile, "processed");
  const ffmpegInstalled = await commandExists("ffmpeg");
  let ffmpegFailure: string | null = null;

  if (ffmpegInstalled) {
    try {
      await transcodeRecordedVideoWithFfmpeg(
        outputFile,
        tempOutputPath,
        rotationAngle,
        options.scale,
        options.outputCodec
      );
      await replaceFileWithTempOutput(tempOutputPath, outputFile);

      return {
        applied: true,
        changes: requestedChanges,
        outputCodec: options.outputCodec,
        method: "ffmpeg",
        note: rotationNote,
      };
    } catch (error) {
      ffmpegFailure = summarizeErrorMessage(describeCommandError(error));
      await fs.promises.unlink(tempOutputPath).catch(() => {});
    }
  }

  try {
    const swiftResult = await transcodeRecordedVideoWithSwift(
      outputFile,
      tempOutputPath,
      rotationAngle,
      options.scale,
      options.outputCodec
    );
    await replaceFileWithTempOutput(tempOutputPath, outputFile);
    const actualChanges = getChanges(swiftResult.outputCodec);

    return {
      applied: true,
      changes: actualChanges,
      outputCodec: swiftResult.outputCodec,
      method: "swift",
      note: combineNotes(
        rotationNote,
        swiftResult.note,
        ffmpegInstalled
          ? `Fell back to the built-in macOS video exporter after ffmpeg video post-processing failed: ${ffmpegFailure}.`
          : "Install ffmpeg to speed up video post-processing on future recordings."
      ),
    };
  } catch (error) {
    await fs.promises.unlink(tempOutputPath).catch(() => {});
    const swiftFailure = summarizeErrorMessage(describeCommandError(error));

    if (ffmpegInstalled && ffmpegFailure) {
      throw new Error(
        `Failed to apply video post-processing with ffmpeg (${ffmpegFailure}) and with the built-in macOS fallback (${swiftFailure})`
      );
    }

    throw new Error(
      `Failed to apply video post-processing with the built-in macOS fallback: ${swiftFailure}`
    );
  }
}

async function captureRawSimulatorScreenshot(
  deviceId: string,
  outputPath: string,
  options: ScreenshotOptions = {}
): Promise<void> {
  await run("xcrun", [
    "simctl",
    "io",
    deviceId,
    "screenshot",
    ...(options.type ? [`--type=${options.type}`] : []),
    ...(options.display ? [`--display=${options.display}`] : []),
    ...(options.mask ? [`--mask=${options.mask}`] : []),
    "--",
    outputPath,
  ]);
}

async function rotateImageInPlace(
  filePath: string,
  rotationAngle: RotationAngle
): Promise<void> {
  if (rotationAngle === 0) {
    return;
  }

  await run("sips", ["-r", String(rotationAngle), filePath]);
}

async function savePresentedScreenshot(
  deviceId: string,
  outputPath: string,
  transform: PresentationTransform,
  options: ScreenshotOptions = {}
): Promise<void> {
  const screenshotType = options.type ?? "png";
  const tempPath = createTempFilePath("screenshot", screenshotType);

  try {
    await captureRawSimulatorScreenshot(deviceId, tempPath, {
      ...options,
      type: screenshotType,
    });
    await rotateImageInPlace(tempPath, transform.rotationAngle);

    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.promises.copyFile(tempPath, outputPath);
  } finally {
    await fs.promises.unlink(tempPath).catch(() => {});
  }
}

function getWdaBaseUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function getSwipeDurationSeconds(duration: string | undefined): string {
  return duration ?? DEFAULT_SWIPE_DURATION_SECONDS;
}

function getSwipeDurationMs(duration: string | undefined): number {
  if (!duration) {
    return DEFAULT_SWIPE_DURATION_MS;
  }

  return Math.max(1, Math.round(Number(duration) * 1000));
}

async function withWdaPortLock<T>(fn: () => Promise<T>): Promise<T> {
  let releaseLock = () => {};
  const nextLock = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  const previousLock = wdaPortLock;
  wdaPortLock = previousLock.then(() => nextLock);

  await previousLock;

  try {
    return await fn();
  } finally {
    releaseLock();
  }
}

async function withWdaSharedDerivedDataLock<T>(
  fn: () => Promise<T>
): Promise<T> {
  let releaseLock = () => {};
  const nextLock = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  const previousLock = wdaSharedDerivedDataLock;
  wdaSharedDerivedDataLock = previousLock.then(() => nextLock);

  await previousLock;

  try {
    return await fn();
  } finally {
    releaseLock();
  }
}

async function getListeningPidsForPort(port: number): Promise<string[]> {
  try {
    const { stdout } = await run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
    return Array.from(new Set(stdout.split(/\s+/).filter(Boolean)));
  } catch {
    return [];
  }
}

async function isPortAvailable(port: number): Promise<boolean> {
  return (await getListeningPidsForPort(port)).length === 0;
}

async function isWdaPortPairAvailable(port: number): Promise<boolean> {
  const mjpegPort = getWdaMjpegPort(port);
  const [isHttpPortAvailable, isMjpegPortAvailable] = await Promise.all([
    isPortAvailable(port),
    isPortAvailable(mjpegPort),
  ]);
  return isHttpPortAvailable && isMjpegPortAvailable;
}

function pruneWdaPorts(bootedDevices: BootedDevice[]): void {
  const bootedDeviceIds = new Set(bootedDevices.map((device) => device.udid));

  for (const deviceId of wdaPortsByDeviceId.keys()) {
    if (!bootedDeviceIds.has(deviceId)) {
      wdaPortsByDeviceId.delete(deviceId);
    }
  }
}

async function isWdaRunning(port: number): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    WDA_STATUS_FETCH_TIMEOUT_MS
  );
  try {
    const response = await fetch(`${getWdaBaseUrl(port)}/status`, {
      signal: controller.signal,
    });
    if (!response.ok) return false;

    const payload = (await response.json()) as WdaStatusResponse;
    return payload.value?.ready === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function getWdaDeviceIdForPort(port: number): Promise<string | null> {
  const pids = await getListeningPidsForPort(port);

  for (const pid of pids) {
    try {
      const { stdout: command } = await run("ps", ["-p", pid, "-o", "command="]);
      const match = command.match(/CoreSimulator\/Devices\/([0-9A-Fa-f-]{36})\//);

      if (match) {
        return match[1].toUpperCase();
      }
    } catch {
      // Ignore transient process lookup failures and keep checking any remaining PIDs.
    }
  }

  return null;
}

function removeWdaPortMappings(port: number): void {
  for (const [deviceId, mappedPort] of wdaPortsByDeviceId.entries()) {
    if (mappedPort === port) {
      wdaPortsByDeviceId.delete(deviceId);
    }
  }
}

async function getVerifiedWdaDeviceIdForPort(
  port: number,
  expectedDeviceId: string
): Promise<string> {
  const runningDeviceId = await getWdaDeviceIdForPort(port);

  if (!runningDeviceId) {
    throw new Error(
      `WebDriverAgent is responding on port ${port}, but the owning simulator could not be determined`
    );
  }

  const normalizedExpectedDeviceId = expectedDeviceId.toUpperCase();
  if (runningDeviceId !== normalizedExpectedDeviceId) {
    throw new Error(
      `WebDriverAgent port ${port} belongs to simulator ${runningDeviceId}, not requested simulator ${normalizedExpectedDeviceId}`
    );
  }

  return runningDeviceId;
}

function getWdaSessionId(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }

  if (
    "value" in payload &&
    typeof payload.value === "object" &&
    payload.value !== null &&
    "sessionId" in payload.value &&
    typeof payload.value.sessionId === "string"
  ) {
    return payload.value.sessionId;
  }

  if ("sessionId" in payload && typeof payload.sessionId === "string") {
    return payload.sessionId;
  }

  return null;
}

async function createWdaSession(port: number): Promise<string> {
  const response = await fetch(`${getWdaBaseUrl(port)}/session`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      capabilities: {
        alwaysMatch: {
          platformName: "iOS",
        },
      },
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to create WebDriverAgent session: ${response.status} ${await response.text()}`
    );
  }

  const payload = await response.json();
  const sessionId = getWdaSessionId(payload);
  if (!sessionId) {
    throw new Error(
      `Invalid WebDriverAgent session response: ${JSON.stringify(payload)}`
    );
  }

  return sessionId;
}

async function deleteWdaSession(
  port: number,
  sessionId: string
): Promise<void> {
  try {
    await fetch(`${getWdaBaseUrl(port)}/session/${sessionId}`, { method: "DELETE" });
  } catch {
    // Ignore cleanup errors because the swipe itself has already completed or failed.
  }
}

async function withWdaSession<T>(
  port: number,
  fn: (sessionUrl: string) => Promise<T>
): Promise<T> {
  const sessionId = await createWdaSession(port);

  try {
    return await fn(`${getWdaBaseUrl(port)}/session/${sessionId}`);
  } finally {
    await deleteWdaSession(port, sessionId);
  }
}

async function clearWdaActions(sessionUrl: string): Promise<void> {
  try {
    await fetch(`${sessionUrl}/actions`, { method: "DELETE" });
  } catch {
    // Ignore cleanup errors so they do not mask the main swipe result.
  }
}

async function performWdaSwipe(
  port: number,
  deviceId: string,
  xStart: number,
  yStart: number,
  xEnd: number,
  yEnd: number,
  durationMs: number
): Promise<void> {
  await getVerifiedWdaDeviceIdForPort(port, deviceId);

  await withWdaSession(port, async (sessionUrl) => {
    try {
      const response = await fetch(`${sessionUrl}/actions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          actions: [
            {
              type: "pointer",
              id: "finger1",
              parameters: { pointerType: "touch" },
              actions: [
                { type: "pointerMove", duration: 0, x: xStart, y: yStart },
                { type: "pointerDown", button: 0 },
                { type: "pointerMove", duration: durationMs, x: xEnd, y: yEnd },
                { type: "pointerUp", button: 0 },
              ],
            },
          ],
        }),
      });

      if (!response.ok) {
        throw new Error(
          `WebDriverAgent actions request failed: ${response.status} ${await response.text()}`
        );
      }
    } finally {
      await clearWdaActions(sessionUrl);
    }
  });
}

async function performIdbSwipe(
  deviceId: string,
  xStart: number,
  yStart: number,
  xEnd: number,
  yEnd: number,
  durationSeconds: string,
  delta: number | undefined
): Promise<void> {
  const { stderr } = await idb(
    "ui",
    "swipe",
    "--udid",
    deviceId,
    "--duration",
    durationSeconds,
    ...(delta !== undefined ? ["--delta", String(delta)] : []),
    "--json",
    // When passing user-provided values to a command, it's crucial to use `--`
    // to separate the command's options from positional arguments.
    // This prevents the shell from misinterpreting the arguments as options.
    "--",
    String(xStart),
    String(yStart),
    String(xEnd),
    String(yEnd)
  );

  if (stderr) {
    throw new Error(stderr);
  }
}

async function getRawSwipePoints(
  udid: string,
  xStart: number,
  yStart: number,
  xEnd: number,
  yEnd: number
): Promise<{
  rawStartPoint: { x: number; y: number };
  rawEndPoint: { x: number; y: number };
}> {
  const { transform } = await getUiInteractionContext(udid);
  const rawStartPoint = roundUiPoint(
    transformPointToRaw({ x: xStart, y: yStart }, transform)
  );
  const rawEndPoint = roundUiPoint(
    transformPointToRaw({ x: xEnd, y: yEnd }, transform)
  );

  return { rawStartPoint, rawEndPoint };
}

async function launchAppOnSimulator(
  deviceId: string,
  bundleId: string,
  terminateRunning = false
): Promise<string> {
  const { stdout } = await run("xcrun", [
    "simctl",
    "launch",
    ...(terminateRunning ? ["--terminate-running-process"] : []),
    deviceId,
    bundleId,
  ]);

  return stdout;
}

async function restoreAppAfterWdaLaunch(
  deviceId: string,
  restoreAppBundleId: string
): Promise<string | null> {
  if (restoreAppBundleId === WDA_BUNDLE_ID) {
    return null;
  }

  await launchAppOnSimulator(deviceId, restoreAppBundleId);
  return restoreAppBundleId;
}

async function getOrAllocateWdaPort(deviceId: string): Promise<number> {
  return withWdaPortLock(async () => {
    const wdaPortStart = getWdaPortStart();
    const bootedDevices = await getBootedDevices();
    pruneWdaPorts(bootedDevices);
    const normalizedDeviceId = deviceId.toUpperCase();

    const existingPort = wdaPortsByDeviceId.get(normalizedDeviceId);
    if (existingPort !== undefined) {
      if (await isWdaPortPairAvailable(existingPort)) {
        return existingPort;
      }

      if (await isWdaRunning(existingPort)) {
        try {
          await getVerifiedWdaDeviceIdForPort(existingPort, normalizedDeviceId);
          return existingPort;
        } catch {
          removeWdaPortMappings(existingPort);
        }
      }

      wdaPortsByDeviceId.delete(normalizedDeviceId);
    }

    const reservedPorts = new Set(wdaPortsByDeviceId.values());
    for (let offset = 0; offset < WDA_PORT_SEARCH_LIMIT; offset += 1) {
      const port = wdaPortStart + offset;
      if (port > MAX_WDA_PORT) {
        break;
      }

      if (reservedPorts.has(port)) {
        continue;
      }

      if (await isWdaPortPairAvailable(port)) {
        wdaPortsByDeviceId.set(normalizedDeviceId, port);
        return port;
      }

      if (await isWdaRunning(port)) {
        try {
          await getVerifiedWdaDeviceIdForPort(port, normalizedDeviceId);
          wdaPortsByDeviceId.set(normalizedDeviceId, port);
          return port;
        } catch {
          // Keep searching; this listener does not belong to the requested simulator.
        }
      }
    }

    throw new Error(
      `Could not find available WebDriverAgent HTTP and MJPEG ports starting at ${wdaPortStart}`
    );
  });
}

async function getXcodeVersion(): Promise<string> {
  const { stdout } = await run("xcodebuild", ["-version"]);
  return stdout.replace(/\s+/g, "-");
}

async function pathExists(filePath: string): Promise<boolean> {
  return fs.promises
    .access(filePath)
    .then(() => true)
    .catch(() => false);
}

function getWdaProductsDir(): string {
  return path.join(WDA_DERIVED_DATA_DIR, "Build", "Products");
}

function getSimulatorArchitectureName(): string {
  return process.arch === "x64" ? "x86_64" : process.arch;
}

async function getIphoneSimulatorSdkVersion(): Promise<string> {
  const { stdout } = await run("xcrun", [
    "--sdk",
    "iphonesimulator",
    "--show-sdk-version",
  ]);
  return stdout;
}

async function getNewestExistingPath(paths: string[]): Promise<string> {
  const pathsWithStats = await Promise.all(
    paths.map(async (candidatePath) => ({
      path: candidatePath,
      mtimeMs: await fs.promises
        .stat(candidatePath)
        .then((stat) => stat.mtimeMs)
        .catch(() => null),
    }))
  );

  const existingPaths = pathsWithStats.filter(
    (candidate): candidate is { path: string; mtimeMs: number } =>
      candidate.mtimeMs !== null
  );
  if (existingPaths.length === 0) {
    throw new Error("No existing paths found");
  }

  return existingPaths.sort((left, right) => right.mtimeMs - left.mtimeMs)[0].path;
}

async function getWdaXctestrunPath(deviceId: string): Promise<string> {
  const productsDir = getWdaProductsDir();
  const deviceDetails = await getBootedDeviceDetails(deviceId);
  const simulatorSdkVersion = await getIphoneSimulatorSdkVersion().catch(
    () => deviceDetails.iosVersion
  );
  const architectureSuffix = `-${getSimulatorArchitectureName()}${WDA_XCTESTRUN_SUFFIX}`;
  const expectedFileName =
    `${WDA_XCTESTRUN_PREFIX}iphonesimulator${simulatorSdkVersion}${architectureSuffix}`;
  const expectedPath = path.join(productsDir, expectedFileName);

  if (await pathExists(expectedPath)) {
    return expectedPath;
  }

  const sdkPrefix = `${WDA_XCTESTRUN_PREFIX}iphonesimulator${simulatorSdkVersion}-`;
  const runtimePrefix =
    `${WDA_XCTESTRUN_PREFIX}iphonesimulator${deviceDetails.iosVersion}-`;
  const xctestrunEntries = await fs.promises
    .readdir(productsDir)
    .then((entries) => entries.filter(
      (entry) =>
        entry.startsWith(`${WDA_XCTESTRUN_PREFIX}iphonesimulator`) &&
        entry.endsWith(WDA_XCTESTRUN_SUFFIX)
    ))
    .catch(() => []);
  const sdkCandidatePaths = xctestrunEntries
    .filter((entry) => entry.startsWith(sdkPrefix))
    .map((entry) => path.join(productsDir, entry));

  if (sdkCandidatePaths.length > 0) {
    return getNewestExistingPath(sdkCandidatePaths);
  }

  const runtimeCandidatePaths = xctestrunEntries
    .filter((entry) => entry.startsWith(runtimePrefix))
    .map((entry) => path.join(productsDir, entry));

  if (runtimeCandidatePaths.length > 0) {
    return getNewestExistingPath(runtimeCandidatePaths);
  }

  const architectureCandidatePaths = xctestrunEntries
    .filter((entry) => entry.endsWith(architectureSuffix))
    .map((entry) => path.join(productsDir, entry));

  if (architectureCandidatePaths.length > 0) {
    return getNewestExistingPath(architectureCandidatePaths);
  }

  const candidatePaths = xctestrunEntries.map((entry) =>
    path.join(productsDir, entry)
  );
  if (candidatePaths.length > 0) {
    return getNewestExistingPath(candidatePaths);
  }

  const deviceDescription =
    `${deviceDetails.name}, iOS ${deviceDetails.iosVersion}, ` +
    `iphonesimulator SDK ${simulatorSdkVersion}`;
  throw new Error(
    `WebDriverAgent xctestrun file not found for simulator ${deviceId} (${deviceDescription}) in ${productsDir}`
  );
}

async function isWdaBuildCached(deviceId: string): Promise<boolean> {
  try {
    await fs.promises.access(WDA_APP_PATH);
    const xctestrunPath = await getWdaXctestrunPath(deviceId);
    if (!(await hasSupportedWdaXctestrunEnvironmentPath(xctestrunPath))) {
      return false;
    }
    const versionFile = path.join(WDA_CACHE_DIR, "xcode-version");
    const cachedVersion = await fs.promises
      .readFile(versionFile, "utf-8")
      .catch(() => "");
    const currentVersion = await getXcodeVersion();
    return cachedVersion.trim() === currentVersion;
  } catch {
    return false;
  }
}

async function cloneWdaRepo(): Promise<void> {
  if (
    await fs.promises
      .access(path.join(WDA_REPO_DIR, ".git"))
      .then(() => true)
      .catch(() => false)
  ) {
    await run("git", ["-C", WDA_REPO_DIR, "pull", "--ff-only"]);
    return;
  }

  await fs.promises.mkdir(WDA_CACHE_DIR, { recursive: true });
  await run("git", [
    "clone",
    "--depth",
    "1",
    "--single-branch",
    WDA_REPO_URL,
    WDA_REPO_DIR,
  ]);
}

async function buildWda(deviceId: string): Promise<void> {
  let stdout = "";
  let stderr = "";

  try {
    const result = await execFileAsync(
      "xcodebuild",
      [
        "build-for-testing",
        "-quiet",
        "-project",
        path.join(WDA_REPO_DIR, "WebDriverAgent.xcodeproj"),
        "-scheme",
        "WebDriverAgentRunner",
        "-sdk",
        "iphonesimulator",
        "-destination",
        `platform=iOS Simulator,id=${deviceId}`,
        "-derivedDataPath",
        WDA_DERIVED_DATA_DIR,
        "CODE_SIGNING_ALLOWED=NO",
        "CODE_SIGN_IDENTITY=",
        "CODE_SIGNING_REQUIRED=NO",
      ],
      {
        shell: false,
        env: getXcodebuildEnv(),
        timeout: WDA_BUILD_TIMEOUT_MS,
        maxBuffer: WDA_BUILD_MAX_BUFFER_BYTES,
      }
    );

    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    throw new Error(`Failed to build WebDriverAgent: ${describeCommandError(error)}`);
  }

  if (
    !(await pathExists(WDA_APP_PATH))
  ) {
    throw new Error(
      `xcodebuild succeeded but WDA app not found at ${WDA_APP_PATH}. stderr: ${stderr}`
    );
  }

  try {
    await getWdaXctestrunPath(deviceId);
  } catch (error) {
    throw new Error(
      `xcodebuild succeeded but WDA xctestrun file was not found. ${describeCommandError(
        error
      )}. stderr: ${stderr}`
    );
  }

  const currentVersion = await getXcodeVersion();
  await fs.promises.writeFile(
    path.join(WDA_CACHE_DIR, "xcode-version"),
    currentVersion
  );
}

function throwIfServerCleaningUp(action: string): void {
  if (isServerCleaningUp) {
    throw new Error(`Cannot ${action}; the MCP server is shutting down`);
  }
}

async function installWdaOnSimulator(deviceId: string): Promise<void> {
  try {
    await run("xcrun", ["simctl", "install", deviceId, WDA_APP_PATH]);
  } catch (error) {
    throw new Error(
      `Failed to install WebDriverAgent on simulator ${deviceId}: ${describeCommandError(
        error
      )}`
    );
  }
}

async function ensureWdaInstalled(deviceId: string): Promise<void> {
  throwIfServerCleaningUp("install WebDriverAgent");

  if (!(await isWdaBuildCached(deviceId))) {
    await withWdaSharedDerivedDataLock(async () => {
      throwIfServerCleaningUp("build WebDriverAgent");

      if (await isWdaBuildCached(deviceId)) {
        return;
      }

      try {
        await cloneWdaRepo();
      } catch (error) {
        throw new Error(
          `Failed to fetch WebDriverAgent sources: ${describeCommandError(error)}`
        );
      }

      throwIfServerCleaningUp("build WebDriverAgent");
      await buildWda(deviceId);
      throwIfServerCleaningUp("install WebDriverAgent");
    });
  }

  throwIfServerCleaningUp("install WebDriverAgent");
  await installWdaOnSimulator(deviceId);
}

async function withWdaLaunchLock<T>(
  deviceId: string,
  fn: () => Promise<T>
): Promise<T> {
  let releaseLock = () => {};
  const nextLock = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  const previousLock = wdaLaunchLocksByDeviceId.get(deviceId) ?? Promise.resolve();
  const chainedLock = previousLock.then(() => nextLock);
  wdaLaunchLocksByDeviceId.set(deviceId, chainedLock);

  await previousLock;

  try {
    return await fn();
  } finally {
    releaseLock();
    if (wdaLaunchLocksByDeviceId.get(deviceId) === chainedLock) {
      wdaLaunchLocksByDeviceId.delete(deviceId);
    }
  }
}

function getXcodebuildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of XCODEBUILD_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value) {
      env[key] = value;
    }
  }

  env.PATH ??= "/usr/bin:/bin:/usr/sbin:/sbin";
  return env;
}

async function setPlistString(
  plistPath: string,
  keyPath: string,
  value: string
): Promise<void> {
  try {
    await run("plutil", ["-replace", keyPath, "-string", value, plistPath]);
  } catch {
    await run("plutil", ["-insert", keyPath, "-string", value, plistPath]);
  }
}

async function plistKeyExists(
  plistPath: string,
  keyPath: string
): Promise<boolean> {
  try {
    await run("plutil", ["-extract", keyPath, "xml1", "-o", "-", plistPath]);
    return true;
  } catch {
    return false;
  }
}

async function hasSupportedWdaXctestrunEnvironmentPath(
  xctestrunPath: string
): Promise<boolean> {
  for (const envPath of WDA_XCTESTRUN_ENV_PATHS) {
    if (await plistKeyExists(xctestrunPath, envPath)) {
      return true;
    }
  }

  return false;
}

async function setWdaXctestrunEnvironmentValue(
  xctestrunPath: string,
  key: string,
  value: string
): Promise<void> {
  let didSetValue = false;
  let lastError: unknown = null;

  for (const envPath of WDA_XCTESTRUN_ENV_PATHS) {
    try {
      if (!(await plistKeyExists(xctestrunPath, envPath))) {
        continue;
      }
      await setPlistString(xctestrunPath, `${envPath}.${key}`, value);
      didSetValue = true;
    } catch (error) {
      lastError = error;
    }
  }

  if (!didSetValue) {
    const errorDetail =
      lastError === null
        ? `no supported xctestrun environment path found; expected one of ${WDA_XCTESTRUN_ENV_PATHS.join(
            ", "
          )}`
        : describeCommandError(lastError);
    throw new Error(
      `Could not set ${key} in WDA xctestrun environment: ${errorDetail}`
    );
  }
}

async function createWdaLaunchXctestrun(
  sourceXctestrunPath: string,
  port: number
): Promise<string> {
  const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const launchXctestrunPath = path.join(
    path.dirname(sourceXctestrunPath),
    `${WDA_LAUNCH_XCTESTRUN_PREFIX}${port}-${uniqueSuffix}${WDA_XCTESTRUN_SUFFIX}`
  );

  await fs.promises.copyFile(sourceXctestrunPath, launchXctestrunPath);
  try {
    await setWdaXctestrunEnvironmentValue(
      launchXctestrunPath,
      "USE_PORT",
      String(port)
    );
    await setWdaXctestrunEnvironmentValue(
      launchXctestrunPath,
      "MJPEG_SERVER_PORT",
      String(getWdaMjpegPort(port))
    );
  } catch (error) {
    await fs.promises.unlink(launchXctestrunPath).catch(() => {});
    throw error;
  }

  return launchXctestrunPath;
}

async function pruneWdaLaunchXctestrunFiles(): Promise<void> {
  const productsDir = getWdaProductsDir();
  const entries = await fs.promises.readdir(productsDir).catch(() => []);
  const trackedXctestrunPaths = new Set(
    Array.from(wdaProcessesByDeviceId.values()).map(
      (trackedProcess) => trackedProcess.xctestrunPath
    )
  );
  const cutoffMs = Date.now() - WDA_LAUNCH_XCTESTRUN_STALE_MS;
  await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.startsWith(WDA_LAUNCH_XCTESTRUN_PREFIX) &&
          entry.endsWith(WDA_XCTESTRUN_SUFFIX)
      )
      .map(async (entry) => {
        const launchXctestrunPath = path.join(productsDir, entry);
        if (trackedXctestrunPaths.has(launchXctestrunPath)) {
          return;
        }

        const stat = await fs.promises
          .stat(launchXctestrunPath)
          .catch(() => null);
        if (!stat || stat.mtimeMs > cutoffMs) {
          return;
        }

        await fs.promises.unlink(launchXctestrunPath).catch(() => {});
      })
  );
}

function endLogStream(logStream: fs.WriteStream): void {
  if (!logStream.destroyed && !logStream.writableEnded) {
    logStream.end();
  }
}

function writeBoundedLogChunk(
  logStream: fs.WriteStream,
  logState: BoundedLogState,
  chunk: Buffer | string
): void {
  if (logStream.destroyed || logStream.writableEnded) {
    return;
  }

  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  const remainingBytes = WDA_LOG_MAX_BYTES - logState.bytesWritten;
  if (remainingBytes <= 0) {
    if (!logState.truncated) {
      logState.truncated = true;
      logStream.write(`\nLog truncated after ${WDA_LOG_MAX_BYTES} bytes.\n`);
    }
    return;
  }

  if (buffer.length <= remainingBytes) {
    logState.bytesWritten += buffer.length;
    logStream.write(buffer);
    return;
  }

  logState.bytesWritten = WDA_LOG_MAX_BYTES;
  logStream.write(buffer.subarray(0, remainingBytes));
  if (!logState.truncated) {
    logState.truncated = true;
    logStream.write(`\nLog truncated after ${WDA_LOG_MAX_BYTES} bytes.\n`);
  }
}

function isWdaXcodebuildProcessRunning(
  trackedProcess: WdaXcodebuildProcess
): boolean {
  return (
    !trackedProcess.closed &&
    trackedProcess.process.exitCode === null &&
    trackedProcess.process.signalCode === null
  );
}

function signalWdaXcodebuildProcess(
  trackedProcess: WdaXcodebuildProcess,
  signal: NodeJS.Signals
): void {
  const pid = trackedProcess.process.pid;
  if (pid !== undefined) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Fall back to signaling the direct child process.
    }
  }

  try {
    trackedProcess.process.kill(signal);
  } catch {
    // Ignore cleanup errors.
  }
}

async function waitForWdaXcodebuildProcessExit(
  trackedProcess: WdaXcodebuildProcess,
  timeoutMs: number
): Promise<boolean> {
  if (!isWdaXcodebuildProcessRunning(trackedProcess)) {
    return true;
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), timeoutMs);
    trackedProcess.process.once("close", () => {
      clearTimeout(timeout);
      resolve(true);
    });
  });
}

async function terminateWdaOnSimulator(deviceId: string): Promise<void> {
  await run("xcrun", ["simctl", "terminate", deviceId, WDA_BUNDLE_ID], {
    timeoutMs: WDA_TERMINATE_TIMEOUT_MS,
  }).catch(() => {});
}

async function stopWdaXcodebuildProcess(deviceId: string): Promise<void> {
  const trackedProcess = wdaProcessesByDeviceId.get(deviceId);
  if (!trackedProcess) {
    return;
  }

  wdaProcessesByDeviceId.delete(deviceId);
  if (isWdaXcodebuildProcessRunning(trackedProcess)) {
    signalWdaXcodebuildProcess(trackedProcess, "SIGTERM");
    await terminateWdaOnSimulator(deviceId);

    if (
      !(await waitForWdaXcodebuildProcessExit(
        trackedProcess,
        WDA_STOP_TIMEOUT_MS
      ))
    ) {
      signalWdaXcodebuildProcess(trackedProcess, "SIGKILL");
      await waitForWdaXcodebuildProcessExit(trackedProcess, 1_000);
    }
  } else {
    await terminateWdaOnSimulator(deviceId);
  }

  await fs.promises.unlink(trackedProcess.xctestrunPath).catch(() => {});
  await fs.promises
    .rm(trackedProcess.resultBundlePath, { recursive: true, force: true })
    .catch(() => {});
}

async function stopWdaAfterSetupFailure(
  deviceId: string,
  port: number
): Promise<void> {
  removeWdaPortMappings(port);
  await stopWdaXcodebuildProcess(deviceId);
  await terminateWdaOnSimulator(deviceId);
}

async function stopAllWdaXcodebuildProcesses(): Promise<void> {
  await Promise.all(
    Array.from(wdaProcessesByDeviceId.keys()).map((deviceId) =>
      stopWdaXcodebuildProcess(deviceId)
    )
  );
}

function signalAllWdaXcodebuildProcesses(): void {
  for (const trackedProcess of wdaProcessesByDeviceId.values()) {
    if (isWdaXcodebuildProcessRunning(trackedProcess)) {
      signalWdaXcodebuildProcess(trackedProcess, "SIGTERM");
    }
    try {
      fs.unlinkSync(trackedProcess.xctestrunPath);
    } catch {
      // Ignore cleanup errors.
    }
    try {
      fs.rmSync(trackedProcess.resultBundlePath, {
        recursive: true,
        force: true,
      });
    } catch {
      // Ignore cleanup errors.
    }
  }
  wdaProcessesByDeviceId.clear();
}

async function launchWda(
  deviceId: string,
  port: number
): Promise<WdaLaunchResult> {
  // xcodebuild can touch the shared DerivedData tree until WDA is ready, so
  // cold launches are intentionally serialized across simulators.
  return withWdaSharedDerivedDataLock(() => launchWdaLocked(deviceId, port));
}

async function launchWdaLocked(
  deviceId: string,
  port: number
): Promise<WdaLaunchResult> {
  if (isServerCleaningUp) {
    return {
      ok: false,
      reason: "xcodebuild launch skipped because the MCP server is shutting down",
    };
  }

  const existingTrackedProcess = wdaProcessesByDeviceId.get(deviceId);
  if (existingTrackedProcess) {
    if (
      existingTrackedProcess.port === port &&
      isWdaXcodebuildProcessRunning(existingTrackedProcess) &&
      (await isWdaRunning(port))
    ) {
      return { ok: true };
    }

    await stopWdaXcodebuildProcess(deviceId);
  }

  let xctestrunPath: string;
  try {
    await pruneWdaLaunchXctestrunFiles();
    xctestrunPath = await createWdaLaunchXctestrun(
      await getWdaXctestrunPath(deviceId),
      port
    );
  } catch (error) {
    return {
      ok: false,
      reason: `xcodebuild launch preparation failed: ${describeCommandError(error)}`,
    };
  }

  if (isServerCleaningUp) {
    await fs.promises.unlink(xctestrunPath).catch(() => {});
    return {
      ok: false,
      reason: "xcodebuild launch skipped because the MCP server is shutting down",
    };
  }

  await terminateWdaOnSimulator(deviceId);

  if (isServerCleaningUp) {
    await fs.promises.unlink(xctestrunPath).catch(() => {});
    return {
      ok: false,
      reason: "xcodebuild launch skipped because the MCP server is shutting down",
    };
  }

  const resultBundlePath = createTempFilePath("wda-xcodebuild", "xcresult");
  const args = [
    "test-without-building",
    "-xctestrun",
    xctestrunPath,
    "-destination",
    `platform=iOS Simulator,id=${deviceId}`,
    "-derivedDataPath",
    WDA_DERIVED_DATA_DIR,
    "-resultBundlePath",
    resultBundlePath,
    `-only-testing:${WDA_TEST_IDENTIFIER}`,
  ];
  let logPath = "";
  let logStream: fs.WriteStream | null = null;
  let wdaProcess: ChildProcessWithoutNullStreams | null = null;
  try {
    logPath = await writeTempLog(
      "wda-xcodebuild",
      `$ xcodebuild ${args.join(" ")}\n`
    );
    logStream = fs.createWriteStream(logPath, { flags: "a" });
    logStream.on("error", () => {
      // Logging should never crash the MCP server or mask the WDA launch result.
    });
    wdaProcess = spawn("xcodebuild", args, {
      detached: true,
      env: getXcodebuildEnv(),
      shell: false,
    });
  } catch (error) {
    await fs.promises.unlink(xctestrunPath).catch(() => {});
    await fs.promises
      .rm(resultBundlePath, { recursive: true, force: true })
      .catch(() => {});
    if (logStream) {
      endLogStream(logStream);
    }
    const logNote = logPath ? ` Full log written to: ${logPath}` : "";
    return {
      ok: false,
      reason: `xcodebuild launch failed to start: ${describeCommandError(
        error
      )}.${logNote}`,
    };
  }
  if (!logStream || !wdaProcess) {
    await fs.promises.unlink(xctestrunPath).catch(() => {});
    await fs.promises
      .rm(resultBundlePath, { recursive: true, force: true })
      .catch(() => {});
    return {
      ok: false,
      reason: `xcodebuild launch failed to start. Full log written to: ${logPath}`,
    };
  }

  let spawnError: Error | null = null;
  let exitDescription: string | null = null;
  const logState: BoundedLogState = {
    bytesWritten: 0,
    truncated: false,
  };
  const trackedProcess: WdaXcodebuildProcess = {
    closed: false,
    logPath,
    port,
    process: wdaProcess,
    resultBundlePath,
    xctestrunPath,
  };

  wdaProcess.stdout.on("data", (chunk) =>
    writeBoundedLogChunk(logStream, logState, chunk)
  );
  wdaProcess.stderr.on("data", (chunk) =>
    writeBoundedLogChunk(logStream, logState, chunk)
  );
  wdaProcess.once("error", (error) => {
    spawnError = error;
    trackedProcess.closed = true;
    writeBoundedLogChunk(
      logStream,
      logState,
      `\nxcodebuild failed to start: ${describeCommandError(error)}\n`
    );
  });
  wdaProcess.once("close", (code, signal) => {
    trackedProcess.closed = true;
    exitDescription =
      signal !== null ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
    writeBoundedLogChunk(
      logStream,
      logState,
      `\nxcodebuild exited with ${exitDescription}\n`
    );
    logStream.end();

    const currentProcess = wdaProcessesByDeviceId.get(deviceId);
    if (currentProcess?.process === wdaProcess) {
      wdaProcessesByDeviceId.delete(deviceId);
    }
    fs.promises.unlink(xctestrunPath).catch(() => {});
    fs.promises
      .rm(resultBundlePath, { recursive: true, force: true })
      .catch(() => {});
  });

  wdaProcessesByDeviceId.set(deviceId, trackedProcess);

  const shutdownReason =
    `xcodebuild launch stopped because the MCP server is shutting down. ` +
    `Full log written to: ${logPath}`;
  const deadline = Date.now() + WDA_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (isServerCleaningUp) {
      writeBoundedLogChunk(
        logStream,
        logState,
        "\nxcodebuild launch stopped because the MCP server is shutting down\n"
      );
      await stopWdaXcodebuildProcess(deviceId);
      return {
        ok: false,
        reason: shutdownReason,
      };
    }

    if (spawnError) {
      endLogStream(logStream);
      await stopWdaXcodebuildProcess(deviceId);
      return {
        ok: false,
        reason: `xcodebuild launch failed: ${describeCommandError(
          spawnError
        )}. Full log written to: ${logPath}`,
      };
    }

    if (await isWdaRunning(port)) {
      return { ok: true };
    }

    if (exitDescription) {
      wdaProcessesByDeviceId.delete(deviceId);
      fs.promises.unlink(xctestrunPath).catch(() => {});
      return {
        ok: false,
        reason: `xcodebuild exited before WebDriverAgent became ready (${exitDescription}). Full log written to: ${logPath}`,
      };
    }

    await sleep(WDA_STATUS_POLL_INTERVAL_MS);
  }

  await stopWdaXcodebuildProcess(deviceId);

  return {
    ok: false,
    reason: `WebDriverAgent did not report ready on port ${port} within ${
      WDA_START_TIMEOUT_MS / 1000
    } seconds after xcodebuild launch. Full log written to: ${logPath}`,
  };
}

async function getWdaPortForSwipe(
  deviceId: string,
  restoreAppBundleId: string | undefined
): Promise<WdaPortForSwipeResult> {
  return withWdaLaunchLock(deviceId, () =>
    getWdaPortForSwipeLocked(deviceId, restoreAppBundleId)
  );
}

async function getWdaPortForSwipeLocked(
  deviceId: string,
  restoreAppBundleId: string | undefined
): Promise<WdaPortForSwipeResult> {
  const port = await getOrAllocateWdaPort(deviceId);

  if (await isWdaRunning(port)) {
    try {
      await getVerifiedWdaDeviceIdForPort(port, deviceId);
    } catch (error) {
      removeWdaPortMappings(port);
      return {
        port: null,
        reason: `WebDriverAgent setup failed before swipe: ${describeCommandError(
          error
        )}`,
      };
    }

    return { port };
  }

  if (restoreAppBundleId === WDA_BUNDLE_ID) {
    return {
      port: null,
      reason: `The \`restore_app_bundle_id\` cannot be ${WDA_BUNDLE_ID}. Re-run with the app bundle identifier that should return to the foreground after WebDriverAgent launches.`,
    };
  }

  if (!restoreAppBundleId) {
    return {
      port: null,
      reason: `WebDriverAgent is not running on simulator ${deviceId}. Re-run with \`restore_app_bundle_id\` set to the exact app bundle identifier that should return to the foreground after WebDriverAgent launches.`,
    };
  }

  // Try launching WDA (it may already be installed)
  const initialLaunch = await launchWda(deviceId, port);
  if (initialLaunch.ok) {
    try {
      await getVerifiedWdaDeviceIdForPort(port, deviceId);
    } catch (error) {
      await stopWdaAfterSetupFailure(deviceId, port);
      return {
        port: null,
        reason: `WebDriverAgent launch succeeded, but device verification after launch failed: ${describeCommandError(
          error
        )}`,
      };
    }

    try {
      await restoreAppAfterWdaLaunch(deviceId, restoreAppBundleId);
      return { port };
    } catch (error) {
      await stopWdaAfterSetupFailure(deviceId, port);
      return {
        port: null,
        reason: `WebDriverAgent launch succeeded, but app restore after launch failed: ${describeCommandError(
          error
        )}`,
      };
    }
  }

  // WDA not installed — build from source and install
  try {
    await ensureWdaInstalled(deviceId);
  } catch (error) {
    return {
      port: null,
      reason: `WebDriverAgent was not ready on simulator ${deviceId}. Initial launch failed: ${
        initialLaunch.reason
      }. Automatic install also failed: ${describeCommandError(error)}`,
    };
  }

  // Retry launch after install
  const relaunch = await launchWda(deviceId, port);
  if (relaunch.ok) {
    try {
      await getVerifiedWdaDeviceIdForPort(port, deviceId);
    } catch (error) {
      await stopWdaAfterSetupFailure(deviceId, port);
      return {
        port: null,
        reason: `WebDriverAgent started after install, but device verification after launch failed: ${describeCommandError(
          error
        )}`,
      };
    }

    try {
      await restoreAppAfterWdaLaunch(deviceId, restoreAppBundleId);
      return { port };
    } catch (error) {
      await stopWdaAfterSetupFailure(deviceId, port);
      return {
        port: null,
        reason: `WebDriverAgent started after install, but app restore after launch failed: ${describeCommandError(
          error
        )}`,
      };
    }
  }

  return {
    port: null,
    reason: `WebDriverAgent was installed on simulator ${deviceId}, but it still did not become ready. Initial launch failed: ${initialLaunch.reason}. Launch after install failed: ${relaunch.reason}`,
  };
}

// Register tools only if they're not filtered
if (!isToolFiltered("get_booted_sim_ids")) {
  server.tool(
    "get_booted_sim_ids",
    "Get the UDID, name, and iOS version of all currently booted iOS simulators",
    {
      title: "Get Booted Simulator IDs",
      readOnlyHint: true,
      openWorldHint: true,
    },
    async () => {
      try {
        const bootedDevices = await getBootedDevices();

        return {
          isError: false,
          content: [
            {
              type: "text",
              text: JSON.stringify(bootedDevices, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("open_simulator")) {
  server.tool(
    "open_simulator",
    "Opens the iOS Simulator application",
    { title: "Open Simulator", readOnlyHint: false, openWorldHint: true },
    async () => {
      try {
        await run("open", ["-a", "Simulator.app"]);

        return {
          isError: false,
          content: [
            {
              type: "text",
              text: "Simulator.app opened successfully",
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error opening Simulator.app: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("ui_describe_all")) {
  server.tool(
    "ui_describe_all",
    "Describes accessibility information for the entire screen in the iOS Simulator",
    {
      udid: z
        .string()
        .regex(UDID_REGEX)
        .describe("UDID of target simulator"),
    },
    { title: "Describe All UI Elements", readOnlyHint: true, openWorldHint: true },
    async ({ udid }) => {
      try {
        const presentedUiData = await getPresentedUiData(udid);

        return {
          isError: false,
          content: [{ type: "text", text: JSON.stringify(presentedUiData) }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error describing all of the ui: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("ui_tap")) {
  server.tool(
    "ui_tap",
    "Tap on the screen in the iOS Simulator",
    {
      duration: z
        .string()
        .regex(/^\d+(\.\d+)?$/)
        .optional()
        .describe("Press duration"),
      udid: z
        .string()
        .regex(UDID_REGEX)
        .describe("UDID of target simulator"),
      x: z.number().describe("The x-coordinate"),
      y: z.number().describe("The x-coordinate"),
    },
    { title: "UI Tap", readOnlyHint: false, openWorldHint: true },
    async ({ duration, udid, x, y }) => {
      try {
        const { transform } = await getUiInteractionContext(udid);
        const rawPoint = roundUiPoint(
          transformPointToRaw({ x, y }, transform)
        );

        const { stderr } = await idb(
          "ui",
          "tap",
          "--udid",
          udid,
          ...(duration ? ["--duration", duration] : []),
          "--json",
          // When passing user-provided values to a command, it's crucial to use `--`
          // to separate the command's options from positional arguments.
          // This prevents the shell from misinterpreting the arguments as options.
          "--",
          String(rawPoint.x),
          String(rawPoint.y)
        );

        if (stderr) throw new Error(stderr);

        return {
          isError: false,
          content: [{ type: "text", text: "Tapped successfully" }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error tapping on the screen: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("ui_type")) {
  server.tool(
    "ui_type",
    "Input text into the iOS Simulator",
    {
      udid: z
        .string()
        .regex(UDID_REGEX)
        .describe("UDID of target simulator"),
      text: z
        .string()
        .max(500)
        .regex(/^[\x20-\x7E]+$/)
        .describe("Text to input"),
    },
    { title: "UI Type", readOnlyHint: false, openWorldHint: true },
    async ({ udid, text }) => {
      try {
        const { stderr } = await idb(
          "ui",
          "text",
          "--udid",
          udid,
          // When passing user-provided values to a command, it's crucial to use `--`
          // to separate the command's options from positional arguments.
          // This prevents the shell from misinterpreting the arguments as options.
          "--",
          text
        );

        if (stderr) throw new Error(stderr);

        return {
          isError: false,
          content: [{ type: "text", text: "Typed successfully" }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error typing text into the iOS Simulator: ${
                  toError(error).message
                }`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("ui_swipe_wda")) {
  server.tool(
    "ui_swipe_wda",
    "Swipe on the screen in the iOS Simulator using WebDriverAgent",
    {
      duration: z
        .string()
        .regex(/^\d+(\.\d+)?$/)
        .optional()
        .describe("Swipe duration in seconds (defaults to 1.0)"),
      restore_app_bundle_id: z
        .string()
        .max(256)
        .optional()
        .describe(
          "App bundle identifier to restore after WebDriverAgent is launched. Required when WebDriverAgent is not already running."
        ),
      udid: z
        .string()
        .regex(UDID_REGEX)
        .describe("UDID of target simulator"),
      x_start: z.number().describe("The starting x-coordinate"),
      y_start: z.number().describe("The starting y-coordinate"),
      x_end: z.number().describe("The ending x-coordinate"),
      y_end: z.number().describe("The ending y-coordinate"),
    },
    { title: "UI Swipe (WDA)", readOnlyHint: false, openWorldHint: true },
    async ({
      duration,
      restore_app_bundle_id,
      udid,
      x_start,
      y_start,
      x_end,
      y_end,
    }) => {
      try {
        const normalizedUdid = udid.toUpperCase();
        const swipeDurationMs = getSwipeDurationMs(duration);
        const { rawStartPoint, rawEndPoint } = await getRawSwipePoints(
          normalizedUdid,
          x_start,
          y_start,
          x_end,
          y_end
        );
        const wdaResult = await getWdaPortForSwipe(
          normalizedUdid,
          restore_app_bundle_id
        );

        if (wdaResult.port === null) {
          throw new Error(
            `${wdaResult.reason}. To explicitly use the legacy backend, call \`ui_swipe_legacy\`.`
          );
        }

        try {
          await performWdaSwipe(
            wdaResult.port,
            normalizedUdid,
            rawStartPoint.x,
            rawStartPoint.y,
            rawEndPoint.x,
            rawEndPoint.y,
            swipeDurationMs
          );
        } catch (error) {
          throw new Error(
            `WebDriverAgent swipe failed: ${describeCommandError(
              error
            )}. To explicitly use the legacy backend, call \`ui_swipe_legacy\`.`
          );
        }

        return {
          isError: false,
          content: [
            {
              type: "text",
              text: `Swiped successfully using WebDriverAgent on simulator ${normalizedUdid} via port ${wdaResult.port}`,
            },
          ],
        };
      } catch (error) {
        const detailedError = describeCommandError(error);
        const logPath = await writeTempLog(
          "ui-swipe-wda-error",
          `Error swiping on the screen with WebDriverAgent: ${detailedError}`
        );

        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error swiping on the screen with WebDriverAgent: ${summarizeErrorMessage(
                  detailedError
                )}. Full log written to: ${logPath}`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("ui_swipe_legacy")) {
  server.tool(
    "ui_swipe_legacy",
    "Swipe on the screen in the iOS Simulator using the legacy IDB backend",
    {
      duration: z
        .string()
        .regex(/^\d+(\.\d+)?$/)
        .optional()
        .describe("Swipe duration in seconds (defaults to 1.0)"),
      udid: z
        .string()
        .regex(UDID_REGEX)
        .describe("UDID of target simulator"),
      x_start: z.number().describe("The starting x-coordinate"),
      y_start: z.number().describe("The starting y-coordinate"),
      x_end: z.number().describe("The ending x-coordinate"),
      y_end: z.number().describe("The ending y-coordinate"),
      delta: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Optional advanced legacy IDB step size in pixels between touch points"
        ),
    },
    { title: "UI Swipe (Legacy)", readOnlyHint: false, openWorldHint: true },
    async ({ duration, udid, x_start, y_start, x_end, y_end, delta }) => {
      try {
        const swipeDurationSeconds = getSwipeDurationSeconds(duration);
        const { rawStartPoint, rawEndPoint } = await getRawSwipePoints(
          udid,
          x_start,
          y_start,
          x_end,
          y_end
        );

        await performIdbSwipe(
          udid,
          rawStartPoint.x,
          rawStartPoint.y,
          rawEndPoint.x,
          rawEndPoint.y,
          swipeDurationSeconds,
          delta
        );

        return {
          isError: false,
          content: [
            {
              type: "text",
              text: `Swiped successfully using legacy IDB on simulator ${udid}`,
            },
          ],
        };
      } catch (error) {
        const detailedError = describeCommandError(error);
        const logPath = await writeTempLog(
          "ui-swipe-legacy-error",
          `Error swiping on the screen with legacy IDB: ${detailedError}`
        );

        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error swiping on the screen with legacy IDB: ${summarizeErrorMessage(
                  detailedError
                )}. Full log written to: ${logPath}`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("ui_describe_point")) {
  server.tool(
    "ui_describe_point",
    "Returns the accessibility element at given co-ordinates on the iOS Simulator's screen",
    {
      udid: z
        .string()
        .regex(UDID_REGEX)
        .describe("UDID of target simulator"),
      x: z.number().describe("The x-coordinate"),
      y: z.number().describe("The y-coordinate"),
    },
    { title: "Describe UI Point", readOnlyHint: true, openWorldHint: true },
    async ({ udid, x, y }) => {
      try {
        const { transform } = await getUiInteractionContext(udid);
        const rawPoint = roundUiPoint(
          transformPointToRaw({ x, y }, transform)
        );

        const { stdout, stderr } = await idb(
          "ui",
          "describe-point",
          "--udid",
          udid,
          "--json",
          // When passing user-provided values to a command, it's crucial to use `--`
          // to separate the command's options from positional arguments.
          // This prevents the shell from misinterpreting the arguments as options.
          "--",
          String(rawPoint.x),
          String(rawPoint.y)
        );

        if (stderr) throw new Error(stderr);

        const element = JSON.parse(stdout) as UiElement;

        return {
          isError: false,
          content: [{ type: "text", text: JSON.stringify(element) }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error describing point (${x}, ${y}): ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("ui_find_element")) {
  server.tool(
    "ui_find_element",
    "Searches the accessibility tree and returns elements matching the given criteria",
    {
      udid: z
        .string()
        .regex(UDID_REGEX)
        .describe("UDID of target simulator"),
      search: z
        .array(z.string().min(1))
        .min(1)
        .describe(
          "Array of search strings. An element matches if ANY string matches against its AXLabel or AXUniqueId"
        ),
      type: z
        .string()
        .optional()
        .describe(
          "Filter by element type (e.g. 'Button', 'StaticText', 'Group'). Case-insensitive exact match"
        ),
      matchMode: z
        .enum(["substring", "exact"])
        .optional()
        .default("substring")
        .describe("Match mode for search strings: 'substring' (default) or 'exact'"),
      caseSensitive: z
        .boolean()
        .optional()
        .default(false)
        .describe("Whether search matching is case-sensitive (default: false)"),
    },
    { title: "Find UI Element", readOnlyHint: true, openWorldHint: true },
    async ({ search, type, matchMode, caseSensitive, udid }) => {
      try {
        const presentedUiData = await getPresentedUiData(udid);

        function matchesSearch(
          value: string | null,
          term: string,
          mode: "substring" | "exact",
          sensitive: boolean
        ): boolean {
          if (value == null) return false;
          const v = sensitive ? value : value.toLowerCase();
          const t = sensitive ? term : term.toLowerCase();
          return mode === "exact" ? v === t : v.includes(t);
        }

        function findElements(
          elements: Array<Record<string, unknown>>
        ): Array<Record<string, unknown>> {
          const results: Array<Record<string, unknown>> = [];

          for (const element of elements) {
            const label = element.AXLabel as string | null;
            const uniqueId = element.AXUniqueId as string | null;
            const elementType = element.type as string | undefined;

            const matchesAnySearch = search.some(
              (term) =>
                matchesSearch(label, term, matchMode, caseSensitive) ||
                matchesSearch(uniqueId, term, matchMode, caseSensitive)
            );

            const matchesType =
              type == null ||
              (elementType != null &&
                elementType.toLowerCase() === type.toLowerCase());

            if (matchesAnySearch && matchesType) {
              results.push(element);
            }

            const children = element.children as
              | Array<Record<string, unknown>>
              | undefined;
            if (children && children.length > 0) {
              results.push(...findElements(children));
            }
          }

          return results;
        }

        const results = findElements(presentedUiData);

        return {
          isError: false,
          content: [
            {
              type: "text",
              text: JSON.stringify(results),
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error finding UI elements: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("read_screen")) {
  server.tool(
    "read_screen",
    "Return the current simulator screen as an image for visual inspection. Use this when you need to understand or inspect what is currently on screen. If you need to save an image file to disk, use screenshot instead.",
    {
      udid: z
        .string()
        .regex(UDID_REGEX)
        .describe("UDID of target simulator"),
    },
    { title: "Read screen", readOnlyHint: true, openWorldHint: true },
    async ({ udid }) => {
      try {
        const { transform } = await getUiInteractionContext(udid);
        const pointWidth = transform.presentedWidth;
        const pointHeight = transform.presentedHeight;

        // Generate unique file names with timestamp
        const rawPng = createTempFilePath("ui-view-raw", "png");
        const compressedJpg = createTempFilePath("ui-view-compressed", "jpg");

        // Capture screenshot as PNG
        await captureRawSimulatorScreenshot(udid, rawPng, { type: "png" });
        await rotateImageInPlace(rawPng, transform.rotationAngle);

        // Resize to match point dimensions and compress to JPEG using sips
        await run("sips", [
          "-z",
          String(pointHeight), // height in points
          String(pointWidth), // width in points
          "-s",
          "format",
          "jpeg",
          "-s",
          "formatOptions",
          "80", // 80% quality
          rawPng,
          "--out",
          compressedJpg,
        ]);

        // Read and encode the compressed image
        const imageData = fs.readFileSync(compressedJpg);
        const base64Data = imageData.toString("base64");

        return {
          isError: false,
          content: [
            {
              type: "image",
              data: base64Data,
              mimeType: "image/jpeg",
            },
            {
              type: "text",
              text: "Screenshot captured",
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error capturing screenshot: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

function ensureAbsolutePath(filePath: string): string {
  if (path.isAbsolute(filePath)) {
    return filePath;
  }

  // Handle ~/something paths in the provided filePath
  if (filePath.startsWith("~/")) {
    return path.join(os.homedir(), filePath.slice(2));
  }

  // Determine the default directory from env var or fallback to ~/Downloads
  let defaultDir = path.join(os.homedir(), "Downloads");
  const customDefaultDir = process.env.IOS_SIMULATOR_MCP_DEFAULT_OUTPUT_DIR;

  if (customDefaultDir) {
    // also expand tilde for the custom directory path
    if (customDefaultDir.startsWith("~/")) {
      defaultDir = path.join(os.homedir(), customDefaultDir.slice(2));
    } else {
      defaultDir = customDefaultDir;
    }
  }

  // Join the relative filePath with the resolved default directory
  return path.join(defaultDir, filePath);
}

function isChildProcessFinished(
  childProcess: ChildProcessWithoutNullStreams
): boolean {
  return childProcess.exitCode !== null || childProcess.signalCode !== null;
}

function clearTrackedRecording(
  udid: string,
  recordingProcess?: ChildProcessWithoutNullStreams
): void {
  if (
    !recordingProcess ||
    activeRecordingsByUdid.get(udid)?.process === recordingProcess
  ) {
    activeRecordingsByUdid.delete(udid);
  }

  recordingStartupReservationsByUdid.delete(udid);
}

function getTrackedRecording(
  udid: string
): ActiveRecording | null {
  const recording = activeRecordingsByUdid.get(udid);

  if (!recording) {
    return null;
  }

  if (isChildProcessFinished(recording.process)) {
    clearTrackedRecording(udid, recording.process);
    return null;
  }

  return recording;
}

function registerRecordingLifecycle(
  udid: string,
  recordingProcess: ChildProcessWithoutNullStreams
): void {
  const cleanup = () => {
    clearTrackedRecording(udid, recordingProcess);
  };

  recordingProcess.once("exit", cleanup);
  recordingProcess.once("error", cleanup);
}

async function waitForRecordingStartup(
  recordingProcess: ChildProcessWithoutNullStreams
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let errorOutput = "";

    const cleanup = () => {
      clearTimeout(timeout);
      recordingProcess.stderr.off("data", onStderr);
      recordingProcess.off("error", onError);
      recordingProcess.off("exit", onExit);
    };

    const settle = (fn: () => void) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      fn();
    };

    const onStderr = (data: Buffer) => {
      const message = data.toString();

      if (message.includes("Recording started")) {
        settle(() => resolve());
        return;
      }

      errorOutput += message;
    };

    const onError = (error: Error) => {
      settle(() => reject(new Error(errorOutput.trim() || error.message)));
    };

    const onExit = (
      code: number | null,
      signal: NodeJS.Signals | null
    ) => {
      const reason =
        errorOutput.trim() ||
        `Recording process terminated unexpectedly${
          code !== null
            ? ` with exit code ${code}`
            : signal
              ? ` with signal ${signal}`
              : ""
        }`;

      settle(() => reject(new Error(reason)));
    };

    const timeout = setTimeout(() => {
      if (isChildProcessFinished(recordingProcess)) {
        onExit(recordingProcess.exitCode, recordingProcess.signalCode);
        return;
      }

      settle(() => resolve());
    }, RECORDING_START_TIMEOUT_MS);

    recordingProcess.stderr.on("data", onStderr);
    recordingProcess.once("error", onError);
    recordingProcess.once("exit", onExit);
  });
}

async function waitForRecordingToFinalize(
  recordingProcess: ChildProcessWithoutNullStreams
): Promise<void> {
  if (isChildProcessFinished(recordingProcess)) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      recordingProcess.off("exit", onExit);
      recordingProcess.off("error", onError);
    };

    const onExit = () => {
      cleanup();
      resolve();
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const timeout = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Recording process did not exit within ${RECORDING_STOP_FINALIZATION_TIMEOUT_MS}ms after SIGINT`
        )
      );
    }, RECORDING_STOP_FINALIZATION_TIMEOUT_MS);

    recordingProcess.once("exit", onExit);
    recordingProcess.once("error", onError);
  });
}

if (!isToolFiltered("screenshot")) {
  server.tool(
    "screenshot",
    "Save the current simulator screen to an image file on disk. Use this only when you need a persistent file or artifact. If you need to inspect the current screen, use read_screen instead.",
    {
      udid: z
        .string()
        .regex(UDID_REGEX)
        .describe("UDID of target simulator"),
      output_path: z
        .string()
        .max(1024)
        .describe(
          "File path where the screenshot will be saved. If relative, it uses the directory specified by the `IOS_SIMULATOR_MCP_DEFAULT_OUTPUT_DIR` env var, or `~/Downloads` if not set."
        ),
      type: z
        .enum(["png", "tiff", "bmp", "gif", "jpeg"])
        .optional()
        .describe(
          "Image format (png, tiff, bmp, gif, or jpeg). Default is png."
        ),
      display: z
        .enum(["internal", "external"])
        .optional()
        .describe(
          "Display to capture (internal or external). Default depends on device type."
        ),
      mask: z
        .enum(["ignored", "alpha", "black"])
        .optional()
        .describe(
          "For non-rectangular displays, handle the mask by policy (ignored, alpha, or black)"
        ),
    },
    { title: "Save screenshot", readOnlyHint: false, openWorldHint: true },
    async ({ udid, output_path, type, display, mask }) => {
      try {
        const absolutePath = ensureAbsolutePath(output_path);
        const { transform } = await getUiInteractionContext(udid);
        await savePresentedScreenshot(udid, absolutePath, transform, {
          type,
          display,
          mask,
        });

        return {
          isError: false,
          content: [
            {
              type: "text",
              text: `Wrote screenshot to ${absolutePath}`,
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error taking screenshot: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("record_video")) {
  server.tool(
    "record_video",
    "Records a video of the iOS Simulator using simctl directly",
    {
      udid: z
        .string()
        .regex(UDID_REGEX)
        .describe("UDID of target simulator"),
      output_path: z
        .string()
        .max(1024)
        .optional()
        .describe(
          `Optional output path. If not provided, a default name will be used. The file will be saved in the directory specified by \`IOS_SIMULATOR_MCP_DEFAULT_OUTPUT_DIR\` or in \`~/Downloads\` if the environment variable is not set.`
        ),
      codec: z
        .enum(VIDEO_CODEC_VALUES)
        .optional()
        .describe(
          'Specifies the codec type: "h264" or "hevc". Default is "hevc".'
        ),
      display: z
        .enum(["internal", "external"])
        .optional()
        .describe(
          'Display to capture: "internal" or "external". Default depends on device type.'
        ),
      mask: z
        .enum(["ignored", "alpha", "black"])
        .optional()
        .describe(
          'For non-rectangular displays, handle the mask by policy: "ignored", "alpha", or "black".'
        ),
      force: z
        .boolean()
        .optional()
        .describe(
          "Force the output file to be written to, even if the file already exists."
        ),
    },
    { title: "Record Video", readOnlyHint: false, openWorldHint: true },
    async ({ udid, output_path, codec, display, mask, force }) => {
      let actualUdid: string | null = null;
      let recordingProcess: ChildProcessWithoutNullStreams | null = null;
      let outputFile: string | null = null;
      const selectedCodec = codec ?? DEFAULT_RECORDING_CODEC;

      try {
        actualUdid = udid;

        if (
          getTrackedRecording(actualUdid) ||
          recordingStartupReservationsByUdid.has(actualUdid)
        ) {
          throw new Error(
            `A recording is already active or starting for simulator ${actualUdid} in this server instance`
          );
        }

        const defaultFileName = `simulator_recording_${Date.now()}.mp4`;
        outputFile = ensureAbsolutePath(output_path ?? defaultFileName);
        recordingStartupReservationsByUdid.add(actualUdid);
        const startRotationAnglePromise = getRecordingStartRotationAngle(
          actualUdid
        );

        recordingProcess = spawn("xcrun", [
          "simctl",
          "io",
          actualUdid,
          "recordVideo",
          ...(codec ? [`--codec=${codec}`] : []),
          ...(display ? [`--display=${display}`] : []),
          ...(mask ? [`--mask=${mask}`] : []),
          ...(force ? ["--force"] : []),
          // When passing user-provided values to a command, it's crucial to use `--`
          // to separate the command's options from positional arguments.
          // This prevents the shell from misinterpreting the arguments as options.
          "--",
          outputFile,
        ]);
        registerRecordingLifecycle(actualUdid, recordingProcess);

        await waitForRecordingStartup(recordingProcess);
        activeRecordingsByUdid.set(actualUdid, {
          outputFile,
          process: recordingProcess,
          startRotationAngle: await startRotationAnglePromise,
          codec: selectedCodec,
        });
        recordingStartupReservationsByUdid.delete(actualUdid);

        return {
          isError: false,
          content: [
            {
              type: "text",
              text: `Recording started for simulator ${actualUdid}. The video will be saved to: ${outputFile}\nTo stop recording, use stop_recording with the same udid: ${actualUdid}.`,
            },
          ],
        };
      } catch (error) {
        if (recordingProcess && !isChildProcessFinished(recordingProcess)) {
          recordingProcess.kill("SIGINT");
        }

        if (actualUdid) {
          clearTrackedRecording(actualUdid, recordingProcess ?? undefined);
        }

        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error starting recording: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("stop_recording")) {
  server.tool(
    "stop_recording",
    "Stops a tracked simulator video recording for the targeted iOS Simulator",
    {
      udid: z
        .string()
        .regex(UDID_REGEX)
        .describe("UDID of target simulator"),
      fix_rotation: z
        .boolean()
        .optional()
        .describe(
          "Bake the saved video into the simulator's displayed orientation before returning. Defaults to true. Falls back to a slower built-in macOS exporter when ffmpeg is unavailable."
        ),
      scale: z
        .number()
        .positive()
        .optional()
        .describe(
          "Scale factor for the saved video. `0.5` means 50% of the original width and height. Defaults to `0.5`."
        ),
      output_codec: z
        .enum(VIDEO_CODEC_VALUES)
        .optional()
        .describe(
          'Output codec for the saved video: "h264" or "hevc". Defaults to "hevc" (H.265 compression).'
        ),
    },
    { title: "Stop Recording", readOnlyHint: false, openWorldHint: true },
    async ({ udid, fix_rotation, scale, output_codec }) => {
      let actualUdid: string | null = null;
      let recording: ActiveRecording | null = null;
      const requestedScale = scale ?? DEFAULT_STOP_RECORDING_SCALE;
      const requestedOutputCodec =
        output_codec ?? DEFAULT_STOP_RECORDING_OUTPUT_CODEC;

      try {
        actualUdid = udid;
        recording = getTrackedRecording(actualUdid);

        if (!recording) {
          throw new Error(
            `No active recording is tracked for simulator ${actualUdid} in this server instance`
          );
        }

        const recordingProcess = recording.process;
        const signalSent = recordingProcess.kill("SIGINT");
        if (!signalSent && !isChildProcessFinished(recordingProcess)) {
          throw new Error(
            `Failed to send SIGINT to the recording process for simulator ${actualUdid}`
          );
        }

        try {
          await waitForRecordingToFinalize(recordingProcess);
        } finally {
          clearTrackedRecording(actualUdid, recordingProcess);
        }

        let text = `Recording stopped successfully for simulator ${actualUdid}. The video was saved to: ${recording.outputFile}`;

        try {
          const postProcessResult = await postProcessRecordedVideo(
            recording.outputFile,
            recording.startRotationAngle,
            {
              fixRotation: fix_rotation !== false,
              outputCodec: requestedOutputCodec,
              scale: requestedScale,
              sourceCodec: recording.codec,
            }
          );

          if (postProcessResult.applied) {
            text +=
              postProcessResult.method === "ffmpeg"
                ? `\nVideo post-processing was applied automatically using ffmpeg: ${postProcessResult.changes.join(", ")}.`
                : `\nVideo post-processing was applied automatically using the built-in macOS video exporter: ${postProcessResult.changes.join(", ")}.`;
          }

          if (postProcessResult.note) {
            text += `\n${postProcessResult.note}`;
          }
        } catch (postProcessError) {
          text += `\nVideo post-processing failed after the recording was saved: ${toError(postProcessError).message}`;
        }

        return {
          isError: false,
          content: [
            {
              type: "text",
              text,
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error stopping recording: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("install_app")) {
  server.tool(
    "install_app",
    "Installs an app bundle (.app or .ipa) on the iOS Simulator",
    {
      udid: z
        .string()
        .regex(UDID_REGEX)
        .describe("UDID of target simulator"),
      app_path: z
        .string()
        .max(1024)
        .describe(
          "Path to the app bundle (.app directory or .ipa file) to install"
        ),
    },
    { title: "Install App", readOnlyHint: false, openWorldHint: true },
    async ({ udid, app_path }) => {
      try {
        const absolutePath = path.isAbsolute(app_path)
          ? app_path
          : path.resolve(app_path);

        // Check if the app bundle exists
        if (!fs.existsSync(absolutePath)) {
          throw new Error(`App bundle not found at: ${absolutePath}`);
        }

        // run() will throw if the command fails (non-zero exit code)
        await run("xcrun", ["simctl", "install", udid, absolutePath]);

        return {
          isError: false,
          content: [
            {
              type: "text",
              text: `App installed successfully from: ${absolutePath}`,
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error installing app: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("launch_app")) {
  server.tool(
    "launch_app",
    "Launches an app on the iOS Simulator by bundle identifier",
    {
      udid: z
        .string()
        .regex(UDID_REGEX)
        .describe("UDID of target simulator"),
      bundle_id: z
        .string()
        .max(256)
        .describe(
          "Bundle identifier of the app to launch (e.g., com.apple.mobilesafari)"
        ),
      terminate_running: z
        .boolean()
        .optional()
        .describe(
          "Terminate the app if it is already running before launching"
        ),
    },
    { title: "Launch App", readOnlyHint: false, openWorldHint: true },
    async ({ udid, bundle_id, terminate_running }) => {
      try {
        const stdout = await launchAppOnSimulator(
          udid,
          bundle_id,
          terminate_running
        );

        // Extract PID from output if available
        // simctl launch outputs the PID as the first token in stdout
        const pidMatch = stdout.match(/^(\d+)/);
        const pid = pidMatch ? pidMatch[1] : null;

        return {
          isError: false,
          content: [
            {
              type: "text",
              text: pid
                ? `App ${bundle_id} launched successfully with PID: ${pid}`
                : `App ${bundle_id} launched successfully`,
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error launching app: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

runServer().catch(console.error);

let cleanupPromise: Promise<void> | null = null;

async function cleanupServerOnce(): Promise<void> {
  isServerCleaningUp = true;
  await stopAllWdaXcodebuildProcesses();
  wdaPortsByDeviceId.clear();
  server.close();
  try {
    fs.rmSync(TMP_ROOT_DIR, { recursive: true, force: true });
  } catch (error) {
    // Ignore cleanup errors
  }
}

function cleanupServer(): Promise<void> {
  cleanupPromise ??= cleanupServerOnce();
  return cleanupPromise;
}

process.once("exit", () => {
  signalAllWdaXcodebuildProcesses();
});

process.once("SIGINT", () => {
  cleanupServer().finally(() => process.exit(130));
});

process.once("SIGTERM", () => {
  cleanupServer().finally(() => process.exit(143));
});

process.stdin.on("close", async () => {
  console.log("iOS Simulator MCP Server closed");
  await cleanupServer();
});
