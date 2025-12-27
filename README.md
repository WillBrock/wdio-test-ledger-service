# WebdriverIO Test Ledger Service

WDIO service that takes results from [wdio-test-ledger-reporter](https://github.com/WillBrock/wdio-test-ledger-reporter) and uploads them to [testledger.dev](https://testledger.dev)

testledger.dev stores and tracks all test runs with extensive details about each test. This gives you a historical overivew of how your tests are running.

Setup is very simple. All you need to do is add the service and reporter to the `services` and `reporters` arrays in your wdio.conf.js file.

## Install the service

```
npm install wdio-test-ledger-service
```

## Add the service to the services array in wdio.conf.js

```javascript
services: [['test-ledger', {
	reporterOutputDir : './testledger',            // This must match the outputDir from the wdio-test-reporter
	apiUrl            : 'app-api.testledger.dev',  // Defaults to app-api.testledger.dev if none is set
	apiToken          : 'tl_abc123_yoursecret',    // API token from app.testledger.dev
	projectId         : 123,                       // Only needed if using more than one project
	appVersion        : '2.8.10',                  // The code version can also be set here
	enableFlaky       : 1,                         // Will mark tests as flaky if it detects them based on previous runs
	uploadArtifacts   : true,                      // Enable screenshot/video artifact uploads
	screenshotDir     : './screenshots',           // Directory containing screenshots
	videoDir          : './_results_/videos',      // Directory containing videos (e.g. from wdio-video-reporter)
}]],
```

You can create an API token in the UI under Settings -> Profile -> API Keys.

**Tip:** Use the `TESTLEDGER_API_TOKEN` environment variable instead of hardcoding the token:

```javascript
services: [['test-ledger', {
	reporterOutputDir : './testledger',
	projectId         : 123,
}]],
```

```bash
export TESTLEDGER_API_TOKEN="tl_abc123_yoursecret"
npx wdio run wdio.conf.js
```

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
| `uploadArtifacts` | `boolean` | Enable artifact uploads. Default: `false` |
| `screenshotDir` | `string` | Directory containing screenshot files (png, jpg, jpeg, gif, webp) |
| `videoDir` | `string` | Directory containing video files (webm, mp4, mov) |

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
	apiToken          : 'tl_abc123_yoursecret',  // Or use TESTLEDGER_API_TOKEN env var
	uploadArtifacts   : true,
	screenshotDir     : './screenshots',
	videoDir          : './_results_/videos'
}]]
```

Artifacts are matched to test suites based on filename. The service looks for the spec file name within the artifact filename.

## Environment variables

Environment variables can be set when running tests:

* `TESTLEDGER_API_TOKEN` - API token for authentication (recommended for CI)
* `RUN_TITLE`    - Title of the test run. This might be something like a Jira issue key. Defaults to a timestamp if not specified
* `RUN_UUID`     - UUID which can be used to directly link to the test run results. e.g. https://app.testledger.dev/runs/<uuid>
* `APP_VERSION`  - Set the version of app this test run ran against
