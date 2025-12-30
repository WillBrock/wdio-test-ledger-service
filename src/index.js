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

		fs.writeFileSync(`${this.options.reporterOutputDir}/trio-onPrepare.txt`, `onPrepare called`, { encoding : `utf-8` });

		this.start = new Date();
	}

	async onComplete(exit_code, config) {
		let data = null;
		try {
			data = this.buildData(config);
		}
		catch(e) {
			fs.writeFileSync(`${this.options.reporterOutputDir}/trio-builddata-error.txt`, e.message, { encoding : `utf-8` });
			return;
		}


		try {
			const response = await this.post(data);
			const result   = await response.json();

			fs.writeFileSync(`${this.options.reporterOutputDir}/trio-onComplete-post.txt`, `onComplete-post`, { encoding : `utf-8` });

			// Upload artifacts if enabled
			if(this.upload_artifacts && result.status === 'success') {
				await this.upload_all_artifacts(data, result);
			}
		}
		catch(e) {
			fs.writeFileSync(`${this.options.reporterOutputDir}/trio-post-error.txt`, e.message, { encoding : `utf-8` });
		}
	}

	buildData(config) {
		const directory  = path.resolve(this.options.reporterOutputDir);
		const files      = fs.readdirSync(directory);
		const suite_data = {};
		const all_errors = {};
		const all_hooks  = {};


		fs.writeFileSync(`${this.options.reporterOutputDir}/trio-skip-passed.txt`, `Value of SKIP_PASSED_UPLOADS: ${process.env.SKIP_PASSED_UPLOADS}`, { encoding : `utf-8` });
		fs.writeFileSync(`${this.options.reporterOutputDir}/trio-buildData.txt`, `Starting buildData`, { encoding : `utf-8` });

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
				fs.writeFileSync(`${this.options.reporterOutputDir}/trio-readfile-error.txt`, e.message, { encoding : `utf-8` });
			}

			const identifier = file.match(/wdio-(\d+-\d+)-/)[1];

			if(!tmp) {
				continue;
			}

			const content   = JSON.parse(tmp);
			const suite_key = btoa(`${identifier}:${content.spec_file}:${content.capabilities}:${content.title}`);

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
				const test_key = btoa(`${identifier}:${content.spec_file}:${content.capabilities}:${content.title}:${test.title}`);

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

		fs.writeFileSync(`${this.options.reporterOutputDir}/trio-end-buildData.txt`, `Ending buildData`, { encoding : `utf-8` });

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
		return `https://${this.options.apiUrl?.replace(`https://`, ``) || api_url}`;
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
		const artifacts = this.collect_artifacts(data, run_result);

		if(artifacts.length === 0) {
			fs.writeFileSync(`${this.options.reporterOutputDir}/trio-no-artifacts.txt`, `No artifacts found to upload`, { encoding : `utf-8` });
			return;
		}

		fs.writeFileSync(`${this.options.reporterOutputDir}/trio-artifacts-found.txt`, `Found ${artifacts.length} artifacts`, { encoding : `utf-8` });

		try {
			// Request presigned URLs
			const presigned_response = await this.request_presigned_urls(artifacts);

			if(!presigned_response.uploads || presigned_response.uploads.length === 0) {
				fs.writeFileSync(`${this.options.reporterOutputDir}/trio-presigned-empty.txt`, `No presigned URLs returned`, { encoding : `utf-8` });
				return;
			}

			// Upload each artifact to S3
			const upload_results = await this.upload_to_s3(presigned_response.uploads, artifacts);

			// Confirm successful uploads
			const confirmed_ids = upload_results
				.filter(r => r.success)
				.map(r => r.artifact_id);

			if(confirmed_ids.length > 0) {
				await this.confirm_uploads(confirmed_ids);
			}

			fs.writeFileSync(`${this.options.reporterOutputDir}/trio-artifacts-complete.txt`, `Uploaded ${confirmed_ids.length}/${artifacts.length} artifacts`, { encoding : `utf-8` });
		}
		catch(e) {
			fs.writeFileSync(`${this.options.reporterOutputDir}/trio-artifacts-error.txt`, e.message, { encoding : `utf-8` });
		}
	}

	/**
	 * Collect all artifact files and match them to suites/tests
	 */
	collect_artifacts(data, run_result) {
		const artifacts = [];

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

		// Collect screenshots
		if(this.screenshot_dir && fs.existsSync(this.screenshot_dir)) {
			const screenshot_files = this.find_files(this.screenshot_dir, ['.png', '.jpg', '.jpeg', '.gif', '.webp']);

			for(const file_path of screenshot_files) {
				const filename      = path.basename(file_path);
				const matched_suite = this.match_file_to_suite(filename, data.suites, suite_map);

				if(matched_suite) {
					artifacts.push({
						type              : 'screenshot',
						filename          : filename,
						path              : file_path,
						mime_type         : MIME_TYPES[path.extname(file_path).toLowerCase()] || 'image/png',
						file_size         : fs.statSync(file_path).size,
						test_run_suite_id : matched_suite.suite_id,
						test_run_suite_test_id : matched_suite.test_id || null
					});
				}
			}
		}

		// Collect videos
		if(this.video_dir && fs.existsSync(this.video_dir)) {
			const video_files = this.find_files(this.video_dir, ['.webm', '.mp4', '.mov']);

			for(const file_path of video_files) {
				const filename      = path.basename(file_path);
				const matched_suite = this.match_file_to_suite(filename, data.suites, suite_map);

				if(matched_suite) {
					artifacts.push({
						type              : 'video',
						filename          : filename,
						path              : file_path,
						mime_type         : MIME_TYPES[path.extname(file_path).toLowerCase()] || 'video/webm',
						file_size         : fs.statSync(file_path).size,
						test_run_suite_id : matched_suite.suite_id,
						test_run_suite_test_id : matched_suite.test_id || null
					});
				}
			}
		}

		return artifacts;
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
	 * Match an artifact filename to a suite based on spec file name
	 */
	match_file_to_suite(filename, suites, suite_map) {
		const lower_filename = filename.toLowerCase();

		for(const suite of suites) {
			// Extract spec file name without extension
			const spec_base = path.basename(suite.spec_file, path.extname(suite.spec_file)).toLowerCase();

			// Check if the artifact filename contains the spec name
			if(lower_filename.includes(spec_base)) {
				const suite_key = `${suite.title}:${suite.spec_file}:${suite.capabilities}`;
				const suite_id  = suite_map[suite_key];

				if(suite_id) {
					return {
						suite_id : suite_id,
						test_id  : null // Could enhance to match specific tests
					};
				}
			}
		}

		// If no match found, return the first suite as fallback
		if(suites.length > 0) {
			const suite     = suites[0];
			const suite_key = `${suite.title}:${suite.spec_file}:${suite.capabilities}`;
			const suite_id  = suite_map[suite_key];

			if(suite_id) {
				return {
					suite_id : suite_id,
					test_id  : null
				};
			}
		}

		return null;
	}

	/**
	 * Request presigned URLs from Test Ledger API
	 */
	async request_presigned_urls(artifacts) {
		const payload = {
			artifacts: artifacts.map(a => ({
				test_run_suite_test_id : a.test_run_suite_test_id,
				test_run_suite_id      : a.test_run_suite_id,
				artifact_type          : a.type,
				filename               : a.filename,
				mime_type              : a.mime_type,
				file_size              : a.file_size
			}))
		};

		const response = await fetch(`${this.getApiUrl()}/artifacts/presigned-upload`, {
			method  : 'POST',
			headers : {
				'Content-Type'  : 'application/json',
				'Authorization' : this.getAuthHeader()
			},
			body : JSON.stringify(payload)
		});

		return response.json();
	}

	/**
	 * Upload artifacts to S3 using presigned URLs
	 */
	async upload_to_s3(uploads, artifacts) {
		const results = [];

		for(let i = 0; i < uploads.length; i++) {
			const upload   = uploads[i];
			const artifact = artifacts[i];

			try {
				const file_buffer = fs.readFileSync(artifact.path);

				const response = await fetch(upload.presigned_url, {
					method  : 'PUT',
					headers : {
						'Content-Type' : artifact.mime_type
					},
					body : file_buffer
				});

				if(response.ok) {
					results.push({
						artifact_id : upload.artifact_id,
						success     : true
					});
				}
				else {
					results.push({
						artifact_id : upload.artifact_id,
						success     : false,
						error       : `HTTP ${response.status}`
					});
				}
			}
			catch(e) {
				results.push({
					artifact_id : upload.artifact_id,
					success     : false,
					error       : e.message
				});
			}
		}

		return results;
	}

	/**
	 * Confirm successful uploads with Test Ledger API
	 */
	async confirm_uploads(artifact_ids) {
		const response = await fetch(`${this.getApiUrl()}/artifacts/confirm`, {
			method  : 'POST',
			headers : {
				'Content-Type'  : 'application/json',
				'Authorization' : this.getAuthHeader()
			},
			body : JSON.stringify({ artifact_ids: artifact_ids })
		});

		return response.json();
	}
}

export default class TestReporterService {};
export const launcher = TestLedgerLauncher;
