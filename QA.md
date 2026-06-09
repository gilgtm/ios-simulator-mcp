# Quality Assurance

This guide contains manual quality assurance tests to make sure all the tools in this MCP server is functional on release.

You can run a test case copy and pasting the test case into a chat in an MCP client (like Cursor) that can run MCP tools.

## Test Case: Photos app

**Note:** This test case was written using iOS 17.2 and the native Photos app. It may need to be adjusted for other iOS versions or Photos app changes.

1. Have the user open the native Photo app in the iOS simulator.
2. Call `get_booted_sim_ids` to get the UDID, name, and iOS version of the booted simulators, choose the simulator under test, and keep that UDID handy for the recording steps below.
3. Call `record_video` with the chosen simulator UDID to start recording a screen recording of the test.
4. Call `ui_describe_all` with the chosen simulator UDID to make sure we are on the All Photos tab.
5. Call `ui_find_element` with the chosen simulator UDID and `{ "search": ["Search"], "type": "Button" }` to find the Search tab button by its label.
6. Call `ui_describe_point` with the chosen simulator UDID to verify the coordinates returned by `ui_find_element` for the Search tab button.
7. Call `ui_tap` with the chosen simulator UDID to tap the Search tab button.
8. Call `ui_tap` with the chosen simulator UDID to focus on the Search text input.
9. Call `ui_type` with the chosen simulator UDID to type "Photos" into the Search text input.
10. Call `ui_describe_all` with the chosen simulator UDID to describe the page and find the first photo result.
11. Call `ui_describe_point` with the chosen simulator UDID to find the x and y coordinates for the first photo result touchable area.
12. Call `ui_tap` with the chosen simulator UDID to tap the coordinates of the first photo result touchable area.
13. Call `ui_swipe_wda` with the chosen simulator UDID to swipe from the center of the screen down to dismiss the photo and go back to the All Photos tab. If WebDriverAgent is not already running, include `restore_app_bundle_id` for the foreground app so it can be restored after launch.
14. Call `ui_describe_all` with the chosen simulator UDID to describe the page and see we are the All Photos tab.
15. Call `screenshot` with the chosen simulator UDID to take a screenshot of the current page.
16. Call `read_screen` with the chosen simulator UDID to view the current page.
17. Call `stop_recording` with the same simulator UDID to stop the screen recording.

## Test Case: Landscape orientation

**Note:** Run this on an iPad simulator and rotate the Simulator window to landscape before starting.

1. Have the user open the iPad Simulator in landscape and show the Home Screen or Photos app.
2. Call `get_booted_sim_ids` and pick the landscape simulator under test by its name and iOS version.
3. Call `read_screen` with the chosen simulator UDID and verify the returned image is landscape-shaped and matches the presented Simulator orientation.
4. Call `ui_describe_all` with the chosen simulator UDID and confirm the root `frame` dimensions are landscape-oriented.
5. Call `ui_find_element` with the chosen simulator UDID to locate a visible element in the current landscape view.
6. Use the returned frame coordinates with `ui_tap` and the chosen simulator UDID to verify the visible element is activated.
7. Call `ui_describe_point` with the chosen simulator UDID and a point chosen from the visible landscape image, then confirm it identifies the expected element.
8. Call `ui_swipe_legacy` with the chosen simulator UDID and a vertical swipe in the visible landscape image, then confirm the gesture moves in the expected on-screen direction.
9. Call `screenshot` with the chosen simulator UDID and verify the saved file matches the same presented landscape orientation as `read_screen`.

## Test Case: Cold WebDriverAgent launch

**Note:** Run this with the MCP server configured with `IOS_SIMULATOR_MCP_WDA_PORT=8123`.

1. Quit any existing MCP client session so no WebDriverAgent process is being held open by this server.
2. Move `~/.ios-simulator-mcp/wda` aside or delete it so the first call exercises a cold WebDriverAgent fetch/build/install.
3. Boot a simulator and open Safari or another simple foreground app.
4. Call `get_booted_sim_ids`, choose the simulator under test, and keep that UDID handy.
5. Call `ui_swipe_wda` with the chosen simulator UDID, a visible swipe gesture, and `restore_app_bundle_id` set to the foreground app bundle identifier.
6. Confirm the first call starts WebDriverAgent automatically, restores the foreground app, completes the swipe successfully, and reports the configured custom port in the tool response.
7. Confirm `curl --fail http://127.0.0.1:8123/status` succeeds.
8. Record the `xcodebuild test-without-building` PID for this simulator, call `ui_swipe_wda` a second time with the same `restore_app_bundle_id`, and confirm it completes successfully with the same WDA PID still running and no new `WebDriverAgentRunnerLaunch-*.xctestrun` file created.
9. Call `ui_swipe_wda` a third time without `restore_app_bundle_id`, using a lowercased version of the same simulator UDID, and confirm it completes successfully with the same WDA PID still running.
10. Quit the MCP client session and confirm `curl --fail http://127.0.0.1:8123/status` fails, no `xcodebuild test-without-building` process remains for the simulator, and no `WebDriverAgentRunnerLaunch-*.xctestrun` files remain in `~/.ios-simulator-mcp/wda/DerivedData/Build/Products`.
11. Start a fresh MCP client session, perform one `ui_swipe_wda` call to start WebDriverAgent again, stop the server with `SIGTERM` or Ctrl-C, and repeat the cleanup checks from step 10.
12. Start another MCP client session with `IOS_SIMULATOR_MCP_WDA_PORT=65000`, confirm `get_booted_sim_ids` still works, and confirm `ui_swipe_wda` returns a validation error explaining that the WebDriverAgent port must be from `1024` through `64535`; repeat the `ui_swipe_wda` validation with `IOS_SIMULATOR_MCP_WDA_PORT=1023`, `IOS_SIMULATOR_MCP_WDA_PORT=64536`, and `IOS_SIMULATOR_MCP_WDA_PORT=not-a-port`. Also confirm `IOS_SIMULATOR_MCP_WDA_PORT=1024` and `IOS_SIMULATOR_MCP_WDA_PORT=64535` proceed past port validation, for example by returning the normal "WebDriverAgent is not running" restore prompt when `restore_app_bundle_id` is omitted.
13. With no WebDriverAgent running, start a temporary listener on `127.0.0.1:9123` such as `python3 -m http.server 9123 --bind 127.0.0.1`, start another MCP client session with `IOS_SIMULATOR_MCP_WDA_PORT=8123`, call `ui_swipe_wda` with `restore_app_bundle_id` set to the app from step 4, and confirm the success message reports `8124` or the next port whose HTTP/MJPEG pair is free. While that MCP session is still open, confirm the selected companion MJPEG port is listening too, for example `lsof -nP -iTCP:9124 -sTCP:LISTEN` when the reported WDA port is `8124`; then quit the MCP client and stop the temporary listener.
14. With a built WDA cache present, replace a cached `WebDriverAgentRunner_*.xctestrun` with a minimal plist that lacks both `WebDriverAgentRunner.EnvironmentVariables` and `WebDriverAgentRunner.TestingEnvironmentVariables`, then start a fresh MCP client session and call `ui_swipe_wda` with `restore_app_bundle_id`; confirm the server treats the cache as invalid, rebuilds WebDriverAgent, and completes the swipe instead of repeatedly failing with `no supported xctestrun environment path found`.
15. With no WebDriverAgent running and a built WDA cache present, back up the cached `WebDriverAgentRunner_*.xctestrun`, keep its environment dictionary intact, and make the cached file launch-invalid by changing `WebDriverAgentRunner.TestBundlePath` to a nonexistent `.xctest` path such as `/tmp/does-not-exist.xctest`. Start a fresh MCP client session with `IOS_SIMULATOR_MCP_WDA_PORT=8123`, call `ui_swipe_wda` with `restore_app_bundle_id`, and confirm the tool reports the post-spawn `xcodebuild` launch failure with a `Full log written to:` path; then confirm no WDA `/status` endpoint, `xcodebuild test-without-building` process, `WebDriverAgentRunnerLaunch-*.xctestrun` file, or `wda-xcodebuild-*.xcresult` bundle remains. Restore the cached `.xctestrun` backup afterward.
16. With no WebDriverAgent running, start another MCP client session with `IOS_SIMULATOR_MCP_WDA_PORT=8123`, call `ui_swipe_wda` with `restore_app_bundle_id` set to a bundle identifier that is not installed, and confirm it reports the app restore failure; then confirm no WDA `/status` endpoint, `xcodebuild test-without-building` process, port mapping reuse, or `WebDriverAgentRunnerLaunch-*.xctestrun` file remains.
17. Boot two simulators, start one MCP client session with `IOS_SIMULATOR_MCP_WDA_PORT=8123`, call `ui_swipe_wda` on both simulator UDIDs with each simulator's foreground app bundle identifier, and confirm the tool responses report distinct WDA ports, both `/status` endpoints belong to the expected devices, and both swipes affect the intended simulator. Quit the MCP client or stop it with `SIGTERM`, then confirm no `xcodebuild test-without-building` process or `WebDriverAgentRunnerLaunch-*.xctestrun` file remains for either simulator.
