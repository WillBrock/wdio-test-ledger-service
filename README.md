# WebdriverIO Test Ledger Service

WDIO service that takes results from [wdio-test-ledger-reporter](https://github.com/WillBrock/wdio-test-ledger-reporter) and uploads them to [testledger.dev](https://testledger.dev)

testledger.dev stores and tracks all test runs with extensive details about each test. This gives you a historical overivew of how your tests are running.

Setup is very simple. All you need to do is add the service and reporter to the `services` and `reporters` arrays in your wdio.conf.js file.

## Install the service

```
npm install wdio-test-ledger-service
```

## Add the service to the services array in wdio.conf.js

```
services: [['test-ledger', {
	reporterOutputDir : `./testledger`,            // This must match the outputDir from the wdio-test-reporter
	apiUrl            : `app-api.testledger.dev`,  // Defaults to app-api.testledger.dev if none is set
	username          : `jenkins@foobar.com`,      // app.testledger.dev username
	apiToken          : `12345`,                   // Found in the app.testledger.dev under your proifle section
	projectId         : 123,                       // Only needed if using more than one project
	appVersion        : `2.8.10`,                  // The code version can also be set here
	enableFlaky       : 1,                         // Will mark tests as flaky if it detects them based on previous runs
	upload_artifacts  : true,                      // Enable screenshot/video artifact uploads
	screenshot_dir    : `./screenshots`,           // Directory containing screenshots
	video_dir         : `./_results_/videos`,      // Directory containing videos (e.g. from wdio-video-reporter)
}]],
```

You will create a custom `username` and `apiToken` in the UI under Settings -> Profile -> API Keys

## Add the wdio-test-ledger-reporter to the reporters array in wdio.conf.js

```
npm install wdio-test-ledger-reporter
```

```
reporters : [[`test-ledger`, {
	outputDir : `./testledger`
}]]
```

## Artifact Uploads (Screenshots & Videos)

The service can upload screenshots and videos to Test Ledger, making them viewable directly in the UI alongside test results.

### Configuration

| Option | Type | Description |
|--------|------|-------------|
| `upload_artifacts` | `boolean` | Enable artifact uploads. Default: `false` |
| `screenshot_dir` | `string` | Directory containing screenshot files (png, jpg, jpeg, gif, webp) |
| `video_dir` | `string` | Directory containing video files (webm, mp4, mov) |

### Example with wdio-video-reporter

```javascript
reporters: [
	['video', {
		saveAllVideos : false,       // Only save videos for failed tests
		videoSlowdownMultiplier : 3,
		outputDir : './_results_/videos'
	}],
	['test-ledger', {
		outputDir : './testledger'
	}]
],
services: [['test-ledger', {
	reporterOutputDir : './testledger',
	username          : 'your-email@example.com',
	apiToken          : 'your-api-token',
	upload_artifacts  : true,
	screenshot_dir    : './screenshots',
	video_dir         : './_results_/videos'
}]]
```

Artifacts are matched to test suites based on filename. The service looks for the spec file name within the artifact filename.

## Environment variables

Environment variables can be set when running tests that the server will use to add to the results

* `RUN_TITLE`    - Title of the test run. This might be something like a Jira issue key. Defaults to a timestamp if not specified
* `RUN_UUID`     - UUID which can be used to directly link to the test run results. e.g. https://app.testledger.dev/runs/c26b23d8-eb9f-4ff4-a884-5cb9f3d3aba5<uuid>
* `APP_VERSION`  - Set the version of app this test run ran against
