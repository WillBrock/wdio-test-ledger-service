import fs   from 'fs-extra';
import path from 'path';
import { SevereServiceError } from 'webdriverio';

const api_url = `https://app-api.testledger.dev`;

// MIME type mapping for artifacts
const MIME_TYPES = {
	'.png'  : 'image/png',
	'.jpg'  : 'image/jpeg',
	'.jpeg' : 'image/jpeg',
	'.gif'  : 'image/gif',
	'.webp' : 'image/webp',
	'.webm' : 'video/webm',
	'.mp4'  : 'video/mp4',
	'.mov'  : 'video/quicktime'
};

const FILE_PREFIX       = `test-ledger-`;
const ERROR_FILE_PREFIX = `${FILE_PREFIX}error-`;

// Server rejects anything larger (see test-reporter-io artifacts.py MAX_FILE_SIZE)
const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;

// The run POST goes through API Gateway (10MB cap) to Lambda (6MB cap). A single
// giant assertion diff stored as both message and stacktrace, times retries, can
// blow past that and lose the whole run. Newer reporters truncate at the source;
// this is the safety net for logs written by older reporter versions.
const MAX_ERROR_CHARS = 64 * 1024;

// If the POST still gets rejected for size, retry once with errors cut to the bone
const RETRY_MAX_ERROR_CHARS = 2 * 1024;

class TestLedgerLauncher {
	constructor(options) {
		this.options = options;

		if(!this.options.reporterOutputDir) {
			throw new SevereServiceError(`No reporterOutputDir specified`)
		}

		// Support env var with fallback to option
		this.apiToken = process.env.TESTLEDGER_API_TOKEN || this.options.apiToken;

		if(!this.apiToken) {
			throw new SevereServiceError(`No apiToken specified. Set TESTLEDGER_API_TOKEN env var or pass apiToken option.`)
		}

		// Artifact upload options
		this.upload_artifacts = this.options.uploadArtifacts || false;
		this.screenshot_dir   = this.options.screenshotDir || null;
		this.video_dir        = this.options.videoDir || null;
	}

	onPrepare() {
		fs.emptyDirSync(this.options.reporterOutputDir);

		this.writeFileSync(`${FILE_PREFIX}onPrepare.txt`, `onPrepare called`);

		this.start = new Date();
	}

	async onComplete(exit_code, config) {
		let data = null;
		try {
			data = this.buildData(config);
		}
		catch(e) {
			this.logError(`${ERROR_FILE_PREFIX}builddata.txt`, e.message);
			return;
		}

		this.truncateErrors(data, MAX_ERROR_CHARS);

		let outcome = await this.postRun(data);

		if(!outcome.result && outcome.retryable) {
			this.logError(`${ERROR_FILE_PREFIX}post-retry.txt`, `Run POST looked like a payload-size rejection, retrying once with errors truncated to ${RETRY_MAX_ERROR_CHARS} chars`);
			this.truncateErrors(data, RETRY_MAX_ERROR_CHARS);
			outcome = await this.postRun(data);
		}

		if(!outcome.result) {
			return;
		}

		const result = outcome.result;

		this.writeFileSync(`${FILE_PREFIX}onComplete-post.txt`, `onComplete-post`, { encoding : `utf-8` });

		// Upload artifacts if enabled
		if(this.upload_artifacts) {
			if(result.status === `success`) {
				await this.upload_all_artifacts(data, result);
			}
			else {
				// Previously this fell through silently and no artifacts were ever uploaded
				this.writeFileSync(`${ERROR_FILE_PREFIX}post-status.txt`, `Run POST returned non-success status: ${JSON.stringify(result).substring(0, 2000)}`);
			}
		}
	}

	/**
	 * POST the run once. Returns { result, retryable }; result is the parsed
	 * response on success, null otherwise. retryable flags failures that look
	 * like payload-size rejections (413 from API Gateway, 5xx from the Lambda
	 * 6MB invoke cap, or a connection torn down mid-body).
	 */
	async postRun(data) {
		try {
			const response = await this.post(data);

			if(!response.ok) {
				const text = await response.text();
				this.logError(`${ERROR_FILE_PREFIX}post.txt`, `Status: ${response.status} ${response.statusText}\nResponse: ${text.substring(0, 2000)}`);

				return {
					result    : null,
					retryable : response.status === 413 || response.status >= 500,
				};
			}

			return {
				result    : await response.json(),
				retryable : false,
			};
		}
		catch(e) {
			this.logError(`${ERROR_FILE_PREFIX}post.txt`, e.message);

			return {
				result    : null,
				retryable : /413|payload|body|EPIPE|ECONNRESET|socket/i.test(e.message),
			};
		}
	}

	/**
	 * Cap every stored error message/stacktrace. Middle-truncate so the stack
	 * frames at the end survive a huge assertion diff at the front. Error
	 * objects are shared across retry entries, so track what we have visited
	 * to avoid stacking truncation markers.
	 */
	truncateErrors(data, max_chars) {
		const seen = new Set();

		for(const suite of data.suites || []) {
			for(const test of suite.tests || []) {
				for(const error of test.errors || []) {
					if(!error || seen.has(error)) {
						continue;
					}

					seen.add(error);

					error.message    = this.truncateText(error.message, max_chars);
					error.stacktrace = this.truncateText(error.stacktrace, max_chars);
				}
			}
		}
	}

	truncateText(text, max_chars) {
		if(typeof text !== `string` || text.length <= max_chars) {
			return text;
		}

		const half = Math.floor(max_chars / 2);

		return [
			text.substring(0, half),
			`\n… [test-ledger: truncated ${text.length - max_chars} chars] …\n`,
			text.substring(text.length - half),
		].join(``);
	}

	/**
	 * Failures here used to be visible only in the throwaway workspace files,
	 * so a lost run left nothing in the CI job log. Mirror them to stderr.
	 */
	logError(filename, content) {
		console.error(`[wdio-test-ledger-service] ${filename.replace(FILE_PREFIX, ``).replace(/\.txt$/, ``)}: ${content}`);
		this.writeFileSync(filename, content, { encoding : `utf-8` });
	}

	buildData(config) {
		const directory  = path.resolve(this.options.reporterOutputDir);
		const files      = fs.readdirSync(directory);
		const suite_data = {};
		const all_errors = {};
		const all_hooks  = {};


		this.writeFileSync(`${FILE_PREFIX}skip-passed.txt`, `Value of SKIP_PASSED_UPLOADS: ${process.env.SKIP_PASSED_UPLOADS}`, { encoding : `utf-8` });
		this.writeFileSync(`${FILE_PREFIX}buildData.txt`, `Starting buildData`, { encoding : `utf-8` });

		const data = {
			project_id    : this.options.projectId,
			uuid          : process.env.RUN_UUID,
			// This is a way to group runs together, for example if you're using sharding
			group_uuid    : process.env.GROUP_UUID,
			main_run      : Number(process.env.MAIN_RUN),
			title         : process.env.RUN_TITLE || this.start,
			// Site the tests were ran on
			site          : process.env.SITE,
			build_url     : process.env.BUILD_URL,
			run_date      : this.start.toISOString(),
			duration      : new Date().getTime() - this.start.getTime(),
			version       : process.env.APP_VERSION || process.env.CODE_VERSION || this.options.appVersion || `0.0.1`,
			suites_ran    : config.suite ? config.suite.join(`, `)               : (config.multiRun || config.repeat ? `RepeatRun` : ``),
			issue_user    : process.env.ISSUE_USER ?? null,
			issue_summary : process.env.ISSUE_SUMMARY ?? null,
			enable_flaky  : Number(process.env.ENABLE_FLAKY) || this.options.enableFlaky || 0,
			passed        : 1,
			failed        : 0,
			suites        : [],
		};

		for(const file of files) {
			if(!file.match(/.log/)) {
				continue;
			}

			let tmp = false;
			try {
				const filepath = `${directory}/${file}`;
				tmp            = fs.readFileSync(filepath, { encoding : `utf8` });
			}
			catch(e) {
				// logError, not a silent breadcrumb — a dropped file means a spec
				// vanishes from the run (a FAILED spec reads as "0 failed" downstream)
				this.logError(`${ERROR_FILE_PREFIX}readfile.txt`, `Dropping ${file} from the upload (read failed): ${e.message}`);
			}

			const match = file.match(/wdio-(\d+-\d+)-/);
			if(!match) {
				continue;
			}
			const identifier = match[1];

			if(!tmp) {
				// Empty file = the reporter never finished writing this spec's
				// results (worker died mid-write) — loud for the same reason
				if(tmp === ``) {
					this.logError(`${ERROR_FILE_PREFIX}empty-file.txt`, `Dropping ${file} from the upload (file is empty)`);
				}
				continue;
			}

			let content;
			try {
				content = JSON.parse(tmp);
			}
			catch(e) {
				// logError, not a silent breadcrumb — same reason as the read
				// failure above: this spec's result is about to vanish from the run
				this.logError(`${ERROR_FILE_PREFIX}json-parse.txt`, `Dropping ${file} from the upload (JSON parse failed): ${e.message}`);
				continue;
			}

			const suite_key = Buffer.from(`${identifier}:${content.spec_file}:${content.capabilities}:${content.title}`).toString('base64');

			if(content.passed && Number(process.env.SKIP_PASSED_UPLOADS) === 1) {
				continue;
			}

			suite_data[suite_key] = {
				title        : content.title,
				spec_file    : content.spec_file,
				filepath     : content.filepath,
				capabilities : content.capabilities,
				duration     : content.duration,
				retries      : content.retries || 0,
				passed       : content.passed,
				failed       : content.failed,
				skipped      : content.skipped,
				start        : content.start,
				tests        : [],
			};

			for(const test of content.tests) {
				const hook     = test.type === `hook`;
				const test_key = Buffer.from(`${identifier}:${content.spec_file}:${content.capabilities}:${content.title}:${test.title}`).toString('base64');

				if(!all_errors[test_key]) {
					all_errors[test_key] = [];
				}

				// This will make sure we have stored errors from the same test if it has retried
				all_errors[test_key] = [...all_errors[test_key], ...test.errors];

				const test_data = {
					title    : test.title,
					duration : test.duration,
					passed   : test.passed,
					retries  : test.retries,
					failed   : test.failed,
					skipped  : test.skipped,
					errors   : all_errors[test_key],
				};

				suite_data[suite_key].tests.push(test_data);

				if(hook && !all_hooks[suite_key]) {
					all_hooks[suite_key] = [];
				}

				if(hook) {
					all_hooks[suite_key].push(test_data)
				}
			}

			if(all_hooks[suite_key]) {
				suite_data[suite_key].tests = [...suite_data[suite_key].tests, ...all_hooks[suite_key]];
			}
		}

		const suites = Object.values(suite_data);
		for(const suite of suites) {
			if(!suite.failed) {
				continue;
			}

			data.failed = 1;
			data.passed = 0;

			break;
		}

		this.writeFileSync(`${FILE_PREFIX}end-buildData.txt`, `Ending buildData`, { encoding : `utf-8` });

		data.suites = suites;

		return data;
	}

	post(data) {
		return fetch(this.getApiRoute(), {
			method  : `POST`,
			headers : {
				'Content-Type'  : `application/json`,
				'Authorization' : this.getAuthHeader(),
			},
			body : JSON.stringify(data),
		});
	}

	getApiUrl() {
		if(this.options.apiUrl) {
			return `https://${this.options.apiUrl.replace(`https://`, ``)}`;
		}

		return api_url;
	}

	getApiRoute() {
		return [
			this.getApiUrl(),
			`/runs`,
		].join(``);
	}

	getAuthHeader() {
		return `Bearer ${this.apiToken}`;
	}

	/**
	 * Upload all artifacts (screenshots and videos) after test run is posted
	 */
	async upload_all_artifacts(data, run_result) {
		const artifacts = await this.collect_artifacts(data, run_result);

		if(artifacts.length === 0) {
			this.writeFileSync(`${ERROR_FILE_PREFIX}no-artifacts.txt`, `No artifacts found to upload`, { encoding : `utf-8` });
			return;
		}

		this.writeFileSync(`${FILE_PREFIX}artifacts-found.txt`, `Found ${artifacts.length} artifacts`, { encoding : `utf-8` });
		try {
			// Request presigned URLs; returns [{upload, artifact}] pairs so a
			// server-side per-artifact rejection can never shift the pairing
			const pairs = await this.request_presigned_urls(artifacts);

			if(pairs.length === 0) {
				this.writeFileSync(`${ERROR_FILE_PREFIX}presigned-empty.txt`, `No presigned URLs returned`, { encoding : `utf-8` });
				return;
			}

			// Upload each artifact to S3
			const upload_results = await this.upload_to_s3(pairs);

			const failed = upload_results.filter(r => !r.success);
			if(failed.length > 0) {
				const lines = failed.map(r => `${r.filename}: ${r.error}`);
				this.writeFileSync(`${ERROR_FILE_PREFIX}s3-upload-failures.txt`, lines.join(`\n`));
			}

			// Confirm successful uploads
			const confirmed_ids = upload_results
				.filter(r => r.success)
				.map(r => r.artifact_id);

			if(confirmed_ids.length > 0) {
				await this.confirm_uploads(confirmed_ids);
			}

			this.writeFileSync(`${FILE_PREFIX}artifacts-complete.txt`, `Uploaded ${confirmed_ids.length}/${artifacts.length} artifacts (${pairs.length} presigned, ${failed.length} S3 failures)`, { encoding : `utf-8` });
		}
		catch(e) {
			this.writeFileSync(`${ERROR_FILE_PREFIX}artifacts-error.txt`, e.message, { encoding : `utf-8` });
		}
	}

	/**
	 * Collect all artifact files and match them to suites/tests
	 */
	async collect_artifacts(data, run_result) {
		const artifacts = [];
		const unmatched = [];
		const oversized = [];

		// Build lookup maps from run result
		const suite_map = {};
		for(const suite of run_result.suites) {
			suite_map[suite.suite_key] = suite.id;
		}

		const test_map = {};
		for(const test of run_result.tests) {
			test_map[test.suite_test_key] = {
				id              : test.id,
				test_run_suite_id : test.test_run_suite_id
			};
		}

		const push_artifact = (type, file_path, fallback_mime) => {
			const filename      = path.basename(file_path);
			const matched_suite = this.match_file_to_suite(filename, data.suites, suite_map, test_map);

			if(!matched_suite) {
				unmatched.push(`${type}: ${filename}`);
				return;
			}

			const file_size = fs.statSync(file_path).size;
			if(file_size === 0 || file_size > MAX_ARTIFACT_BYTES) {
				oversized.push(`${type}: ${filename} (${file_size} bytes)`);
				return;
			}

			artifacts.push({
				type                   : type,
				filename               : filename,
				path                   : file_path,
				mime_type              : MIME_TYPES[path.extname(file_path).toLowerCase()] || fallback_mime,
				file_size              : file_size,
				test_run_suite_id      : matched_suite.suite_id,
				test_run_suite_test_id : matched_suite.test_id || null,
			});
		};

		// Collect screenshots
		if(this.screenshot_dir && fs.existsSync(this.screenshot_dir)) {
			const screenshot_files = this.find_files(this.screenshot_dir, [`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`]);

			for(const file_path of screenshot_files) {
				push_artifact(`screenshot`, file_path, `image/png`);
			}
		}

		// Collect videos. ffmpeg may still be rendering the final-retry video when
		// onComplete fires, so wait for each file to stop growing before reading it.
		if(this.video_dir && fs.existsSync(this.video_dir)) {
			const video_files = this.find_files(this.video_dir, [`.webm`, `.mp4`, `.mov`]);

			for(const file_path of video_files) {
				await this.wait_for_file_stable(file_path);
				push_artifact(`video`, file_path, `video/webm`);
			}
		}

		if(unmatched.length > 0) {
			this.writeFileSync(`${ERROR_FILE_PREFIX}unmatched-artifacts.txt`, unmatched.join(`\n`));
		}
		if(oversized.length > 0) {
			this.writeFileSync(`${ERROR_FILE_PREFIX}skipped-artifacts.txt`, oversized.join(`\n`));
		}

		return artifacts;
	}

	/**
	 * Wait until a file's size stops changing (ffmpeg may still be writing it).
	 * Gives up after max_wait_ms and lets the caller take the file as-is.
	 */
	async wait_for_file_stable(file_path, max_wait_ms = 30000, poll_ms = 750) {
		const deadline = Date.now() + max_wait_ms;
		let last_size  = -1;

		while(Date.now() < deadline) {
			let stat;
			try {
				stat = fs.statSync(file_path);
			}
			catch(e) {
				return;
			}

			// Untouched for 5s, or unchanged since last poll -> done rendering
			if(stat.size > 0 && (Date.now() - stat.mtimeMs > 5000 || stat.size === last_size)) {
				return;
			}

			last_size = stat.size;
			await new Promise(resolve => setTimeout(resolve, poll_ms));
		}
	}

	/**
	 * Find all files with given extensions in a directory (recursive)
	 */
	find_files(dir, extensions) {
		const files = [];

		const items = fs.readdirSync(dir, { withFileTypes: true });
		for(const item of items) {
			const full_path = path.join(dir, item.name);

			if(item.isDirectory()) {
				files.push(...this.find_files(full_path, extensions));
			}
			else if(extensions.includes(path.extname(item.name).toLowerCase())) {
				files.push(full_path);
			}
		}

		return files;
	}

	/**
	 * Match an artifact filename to a suite.
	 *
	 * Screenshots are named `<spec basename>-fail-<ts>.png` (wdio afterTest hook),
	 * videos are named from the SUITE TITLE by wdio-video-reporter
	 * (filenamePrefixSource: 'suite'), so we check both candidates. The longest
	 * matching candidate wins so `Login` cannot shadow `Login Admin`. There is
	 * deliberately no fallback: a wrong-suite attachment presents as a missing
	 * artifact on the suite that actually failed.
	 */
	match_file_to_suite(filename, suites, suite_map, test_map = {}) {
		const lower_filename = filename.toLowerCase();

		let best_suite  = null;
		let best_length = 0;

		for(const suite of suites) {
			const spec_base    = path.basename(suite.spec_file, path.extname(suite.spec_file)).toLowerCase();
			const title_prefix = this.normalize_video_prefix(suite.title);

			let matched_length = 0;

			if(spec_base && lower_filename.includes(spec_base)) {
				matched_length = spec_base.length;
			}

			if(title_prefix && lower_filename.startsWith(title_prefix) && title_prefix.length > matched_length) {
				matched_length = title_prefix.length;
			}

			if(matched_length > best_length) {
				best_length = matched_length;
				best_suite  = suite;
			}
		}

		if(!best_suite) {
			return null;
		}

		const suite_key = `${best_suite.title}:${best_suite.spec_file}:${best_suite.capabilities}`;
		const suite_id  = suite_map[suite_key];

		if(!suite_id) {
			return null;
		}

		return {
			suite_id : suite_id,
			test_id  : this.match_failed_test_id(best_suite, test_map),
		};
	}

	/**
	 * Apply the same transformation wdio-video-reporter's generateFilename()
	 * applies to the suite title, so video filenames can be matched back.
	 */
	normalize_video_prefix(title) {
		if(!title) {
			return ``;
		}

		const normalized = encodeURIComponent(String(title).replace(/\s+/g, `-`))
			.replace(/%../g, ``)
			.replace(/\./g, `-`)
			.replace(/[/\\?%*:'|"<>()]/g, ``)
			.toLowerCase();

		// Long filenames get middle-truncated by the video reporter; keep the
		// prefix comfortably under that limit so startsWith still holds
		return normalized.substring(0, 100);
	}

	/**
	 * Resolve the test-level id when it is unambiguous (exactly one failed
	 * test in the suite). Artifacts are per-spec, so with multiple failures
	 * we cannot tell which test a file belongs to and stay at suite level.
	 */
	match_failed_test_id(suite, test_map) {
		const failed_tests = (suite.tests || []).filter(t => t.failed);

		if(failed_tests.length !== 1) {
			return null;
		}

		const test_key = `${suite.title}:${suite.spec_file}:${suite.capabilities}:${failed_tests[0].title}`;
		const entry    = test_map[test_key];

		return entry ? entry.id : null;
	}

	/**
	 * Request presigned URLs from Test Ledger API
	 */
	async request_presigned_urls(artifacts) {
		const BATCH_SIZE = 50;
		const url            = `${this.getApiUrl()}/artifacts/presigned-upload`;
		const pairs          = [];
		const rejected       = [];
		const batch_failures = [];

		// Process artifacts in batches of 50 (API limit)
		for(let i = 0; i < artifacts.length; i += BATCH_SIZE) {
			const batch         = artifacts.slice(i, i + BATCH_SIZE);
			const batch_num     = Math.floor(i / BATCH_SIZE) + 1;
			const total_batches = Math.ceil(artifacts.length / BATCH_SIZE);

			const payload = {
				// Ask the server for per-artifact results instead of failing the
				// whole batch when one artifact is invalid (older servers ignore this)
				partial_ok : true,
				artifacts  : batch.map(a => ({
					test_run_suite_test_id : a.test_run_suite_test_id,
					test_run_suite_id      : a.test_run_suite_id,
					artifact_type          : a.type,
					filename               : a.filename,
					mime_type              : a.mime_type,
					file_size              : a.file_size,
				})),
			};

			this.writeFileSync(`${FILE_PREFIX}presigned-request.txt`, `URL: ${url}\nBatch: ${batch_num}/${total_batches}\nTotal artifacts: ${artifacts.length}\nBatch size: ${batch.length}`);

			let response;
			try {
				response = await fetch(url, {
					method  : `POST`,
					headers : {
						'Content-Type'  : `application/json`,
						'Authorization' : this.getAuthHeader(),
					},
					body : JSON.stringify(payload),
				});
			}
			catch(e) {
				batch_failures.push(`Batch ${batch_num}/${total_batches}: ${e.message}`);
				continue;
			}

			if(!response.ok) {
				const text = await response.text();
				batch_failures.push(`Batch ${batch_num}/${total_batches}: HTTP ${response.status} ${response.statusText}\n${text.substring(0, 2000)}`);
				continue;
			}

			const result = await response.json();

			// New servers return `results` aligned 1:1 with the request; old
			// servers return `uploads`, which is only aligned because they abort
			// the whole batch on any invalid artifact
			const entries = result.results || result.uploads || [];

			for(let j = 0; j < entries.length; j++) {
				const entry = entries[j];

				if(!entry || entry.error || !entry.presigned_url) {
					rejected.push(`${batch[j] ? batch[j].filename : `#${j}`}: ${entry && entry.error ? entry.error : `no presigned URL`}`);
					continue;
				}

				pairs.push({ upload : entry, artifact : batch[j] });
			}
		}

		if(rejected.length > 0) {
			this.writeFileSync(`${ERROR_FILE_PREFIX}presigned-rejected.txt`, rejected.join(`\n`));
		}
		if(batch_failures.length > 0) {
			this.writeFileSync(`${ERROR_FILE_PREFIX}presigned-failed.txt`, batch_failures.join(`\n\n`));
		}

		return pairs;
	}

	/**
	 * Upload artifacts to S3 using presigned URLs. Transient failures retry once.
	 */
	async upload_to_s3(pairs) {
		const results = [];

		for(const { upload, artifact } of pairs) {
			let last_error = null;

			for(let attempt = 1; attempt <= 2; attempt++) {
				try {
					const file_buffer = fs.readFileSync(artifact.path);

					const response = await fetch(upload.presigned_url, {
						method  : `PUT`,
						headers : {
							'Content-Type' : artifact.mime_type,
						},
						body : file_buffer,
					});

					if(response.ok) {
						last_error = null;
						break;
					}

					last_error = `HTTP ${response.status}`;
				}
				catch(e) {
					last_error = e.message;
				}

				if(attempt === 1) {
					await new Promise(resolve => setTimeout(resolve, 2000));
				}
			}

			results.push({
				artifact_id : upload.artifact_id,
				filename    : artifact.filename,
				success     : !last_error,
				error       : last_error,
			});
		}

		return results;
	}

	/**
	 * Confirm successful uploads with Test Ledger API. Retries per batch and
	 * keeps going on failure so one bad batch cannot orphan the rest.
	 */
	async confirm_uploads(artifact_ids) {
		const BATCH_SIZE = 50;
		const url      = `${this.getApiUrl()}/artifacts/confirm`;
		const failures = [];

		for(let i = 0; i < artifact_ids.length; i += BATCH_SIZE) {
			const batch = artifact_ids.slice(i, i + BATCH_SIZE);

			let last_error = null;

			for(let attempt = 1; attempt <= 3; attempt++) {
				try {
					const response = await fetch(url, {
						method  : `POST`,
						headers : {
							'Content-Type'  : `application/json`,
							'Authorization' : this.getAuthHeader(),
						},
						body : JSON.stringify({ artifact_ids : batch }),
					});

					if(response.ok) {
						last_error = null;
						break;
					}

					const text = await response.text();
					last_error = `HTTP ${response.status} ${response.statusText}: ${text.substring(0, 500)}`;
				}
				catch(e) {
					last_error = e.message;
				}

				if(attempt < 3) {
					await new Promise(resolve => setTimeout(resolve, attempt * 2000));
				}
			}

			if(last_error) {
				failures.push(`Batch starting at ${i}: ${last_error}`);
			}
		}

		if(failures.length > 0) {
			this.writeFileSync(`${ERROR_FILE_PREFIX}confirm-failed.txt`, failures.join(`\n`));
		}
	}

	writeFileSync(filePath, content) {
		const reporter_directory = this.options.reporterOutputDir;
		const filepath           = path.join(reporter_directory, filePath);

		fs.writeFileSync(filepath, content, { encoding : `utf-8` });
	}
}

export default class TestReporterService {};
export const launcher = TestLedgerLauncher;
