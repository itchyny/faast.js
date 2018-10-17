import * as sys from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as awsCloudify from "../src/aws/aws-cloudify";
import * as cloudify from "../src/cloudify";
import * as googleCloudify from "../src/google/google-cloudify";
import { disableWarnings, enableWarnings, log, warn } from "../src/log";
import * as funcs from "./functions";

export function checkFunctions(
    description: string,
    cloudProvider: "aws",
    options: awsCloudify.Options
): void;
export function checkFunctions(
    description: string,
    cloudProvider: cloudify.CloudProvider,
    options: cloudify.CommonOptions
): void;
export function checkFunctions(
    description: string,
    cloudProvider: cloudify.CloudProvider,
    options: cloudify.CommonOptions
): void {
    describe(description, () => {
        let remote: cloudify.Promisified<typeof funcs>;
        let lambda: cloudify.AnyCloudFunction;

        beforeAll(async () => {
            try {
                const start = Date.now();
                const cloud = cloudify.create(cloudProvider);
                const opts = { timeout: 30, memorySize: 512, ...options };
                lambda = await cloud.createFunction("./functions", opts);
                remote = lambda.cloudifyModule(funcs);
                log(
                    `Function creation took ${((Date.now() - start) / 1000).toFixed(1)}s`
                );
            } catch (err) {
                warn(err);
            }
        }, 180 * 1000);

        afterAll(async () => {
            await lambda.cleanup();
            // await lambda.stop();
        }, 60 * 1000);

        test("hello: string => string", async () => {
            expect(await remote.hello("Andy")).toBe("Hello Andy!");
        });

        test("fact: number => number", async () => {
            expect(await remote.fact(5)).toBe(120);
        });

        test("concat: (string, string) => string", async () => {
            expect(await remote.concat("abc", "def")).toBe("abcdef");
        });

        test("error: string => raise exception", async () => {
            expect(await remote.error("hey").catch(err => err.message)).toBe(
                "Expected this error. Argument: hey"
            );
        });

        test("noargs: () => string", async () => {
            expect(await remote.noargs()).toBe(
                "successfully called function with no args."
            );
        });

        test("async: () => Promise<string>", async () => {
            expect(await remote.async()).toBe(
                "returned successfully from async function"
            );
        });

        test("path: () => Promise<string>", async () => {
            expect(typeof (await remote.path())).toBe("string");
        });

        test("rejected: () => rejected promise", async () => {
            expect.assertions(1);
            await expect(remote.rejected()).rejects.toThrowError();
        });

        test("promise args not supported", async () => {
            const saved = disableWarnings();
            expect(await remote.promiseArg(Promise.resolve("hello"))).toEqual({});
            saved && enableWarnings();
        });

        test("optional arguments are supported", async () => {
            expect(await remote.optionalArg()).toBe("No arg");
            expect(await remote.optionalArg("has arg")).toBe("has arg");
        });
    });
}

function exec(cmd: string) {
    const result = sys.execSync(cmd).toString();
    log(result);
    return result;
}

function unzipInDir(dir: string, zipFile: string) {
    exec(`rm -rf ${dir} && mkdir -p ${dir} && unzip ${zipFile} -d ${dir}`);
}

export function checkCodeBundle(
    description: string,
    cloudProvider: "aws",
    packageType: string,
    maxZipFileSize?: number,
    options?: awsCloudify.Options,
    expectations?: (root: string) => void
): void;
export function checkCodeBundle(
    description: string,
    cloudProvider: "google" | "google-emulator",
    packageType: string,
    maxZipFileSize?: number,
    options?: googleCloudify.Options,
    expectations?: (root: string) => void
): void;
export function checkCodeBundle(
    description: string,
    cloudProvider: cloudify.CloudProvider,
    packageType: string,
    maxZipFileSize?: number,
    options?: any,
    expectations?: (root: string) => void
) {
    describe(description, () => {
        test(
            "package zip file",
            async () => {
                const identifier = `func-${cloudProvider}-${packageType}`;
                const tmpDir = path.join("tmp", identifier);
                exec(`mkdir -p ${tmpDir}`);
                const zipFile = path.join("tmp", identifier) + ".zip";
                const { archive } = await cloudify
                    .create(cloudProvider)
                    .pack("./functions", options);

                await new Promise((resolve, reject) => {
                    const output = fs.createWriteStream(zipFile);
                    output.on("finish", resolve);
                    output.on("error", reject);
                    archive.pipe(output);
                });
                maxZipFileSize &&
                    expect(fs.statSync(zipFile).size).toBeLessThan(maxZipFileSize);
                unzipInDir(tmpDir, zipFile);
                expect(exec(`cd ${tmpDir} && node index.js`)).toMatch(
                    "Successful cold start."
                );
                expectations && expectations(tmpDir);
            },
            30 * 1000
        );
    });
}

export function checkLogs(description: string, cloudProvider: cloudify.CloudProvider) {
    describe(description, () => {
        let remote: cloudify.Promisified<typeof funcs>;
        let lambda: cloudify.AnyCloudFunction;

        beforeAll(async () => {
            try {
                const cloud = cloudify.create(cloudProvider);
                const options = {
                    timeout: 30,
                    memorySize: 512
                };
                lambda = await cloud.createFunction("./functions", options);
                remote = lambda.cloudifyModule(funcs);
            } catch (err) {
                warn(err);
            }
        }, 90 * 1000);

        afterAll(async () => {
            await lambda.cleanup();
            // await lambda.stop();
        }, 60 * 1000);

        test(
            "logs console.*",
            async () => {
                const received = {};
                let logger;
                const logPromise = new Promise(resolve => {
                    logger = (msg: string) => {
                        // log(`logger: ${msg}`);
                        const result = msg.match(/(console.\w+) works/);
                        if (result && result[1]) {
                            received[result[1]] = true;
                        }
                        // log(`received: %O`, received);
                        if (Object.keys(received).length === 4) {
                            resolve();
                        }
                    };
                });
                lambda.setLogger(logger);
                await remote.consoleLog("console.log works");
                await remote.consoleWarn("console.warn works");
                await remote.consoleError("console.error works");
                await remote.consoleInfo("console.info works");
                await logPromise;
                lambda.setLogger(undefined);
                expect(received["console.log"]).toBe(true);
                expect(received["console.warn"]).toBe(true);
                expect(received["console.error"]).toBe(true);
                expect(received["console.info"]).toBe(true);
            },
            120 * 1000
        );

        test.only(
            "concurrent logs",
            async () => {
                let logger;
                const N = 100;
                const logEntries = {};

                const logPromise = new Promise(resolve => {
                    logger = (msg: string) => {
                        log(msg);
                        const match = msg.match(/Executed call ([0-9]+)/);
                        if (match) {
                            logEntries[match[1]] = (logEntries[match[1]] || 0) + 1;
                        }

                        if (Object.keys(logEntries).length === N) {
                            resolve();
                        }
                    };
                });

                lambda.setLogger(logger);
                const promises = [];
                for (let i = 0; i < N; i++) {
                    promises.push(remote.consoleLog(`Executed call ${i}`));
                }
                await Promise.all(promises);
                const timer = setInterval(() => {
                    const missing = [];
                    const duplicate = [];
                    for (let i = 0; i < N; i++) {
                        if (!logEntries[i]) {
                            missing.push(i);
                        } else if (logEntries[i] > 1) {
                            duplicate.push(i);
                        }
                    }
                    log(`missing: ${missing}, duplicate: ${duplicate}`);
                }, 1000);

                await logPromise;

                for (let i = 0; i < N; i++) {
                    expect(logEntries[i]).toBe(1);
                }
                clearInterval(timer);
                lambda.setLogger(undefined);
            },
            180 * 1000
        );
    });
}

export function checkCosts(
    description: string,
    cloudProvider: cloudify.CloudProvider,
    options: cloudify.CommonOptions = {}
) {
    describe(description, () => {
        let remote: cloudify.Promisified<typeof funcs>;
        let lambda: cloudify.AnyCloudFunction;

        beforeAll(async () => {
            try {
                const cloud = cloudify.create(cloudProvider);
                const args: cloudify.CommonOptions = {
                    timeout: 30,
                    memorySize: 512,
                    useQueue: true
                };
                lambda = await cloud.createFunction("./functions", {
                    ...args,
                    ...options
                });
                remote = lambda.cloudifyModule(funcs);
                lambda.setLogger(console.log);
            } catch (err) {
                warn(err);
            }
        }, 120 * 1000);

        afterAll(async () => {
            await lambda.cleanup();
            // await lambda.stop();
        }, 60 * 1000);

        test(
            "cost for basic call",
            async () => {
                await remote.hello("there");
                const costs = await lambda.costEstimate();
                log(`${costs}`);
                log(`CSV costs:\n${costs.csv()}`);

                const { estimatedBilledTime } = lambda.functionStats.aggregate;
                expect(
                    (estimatedBilledTime.mean * estimatedBilledTime.samples) / 1000
                ).toBe(
                    costs.metrics.find(m => m.name === "functionCallDuration")!.measured
                );

                expect(costs.metrics.length).toBeGreaterThan(1);
                expect(costs.find("functionCallRequests")!.measured).toBe(1);
                for (const metric of costs.metrics) {
                    expect(metric.cost()).toBeGreaterThan(0);
                    expect(metric.cost()).toBeLessThan(0.00001);
                    expect(metric.measured).toBeGreaterThan(0);
                    expect(metric.name.length).toBeGreaterThan(0);
                    expect(metric.pricing).toBeGreaterThan(0);
                    expect(metric.unit.length).toBeGreaterThan(0);
                    expect(metric.cost()).toBe(metric.pricing * metric.measured);
                }
                expect(costs.total()).toBeGreaterThan(0);
            },
            30 * 1000
        );
    });
}
