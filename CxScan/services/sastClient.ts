import {ScanRequest} from "../dto/scanRequest";
import {ScanConfig} from "../dto/scanConfig";
import {HttpClient} from "./httpClient";
import {ScanStatus} from "../dto/scanStatus";
import {ScanStage} from "../dto/scanStage";
import {Stopwatch} from "./stopwatch";
import {UpdateScanSettingsRequest} from "../dto/updateScanSettingsRequest";
import {Waiter} from "./waiter";
import {Logger} from "./logger";

export class SastClient {
    private static readonly scanCompletedDetails = 'Scan completed';

    private readonly stopwatch = new Stopwatch();

    private scanId: number = 0;

    constructor(private readonly config: ScanConfig,
                private readonly httpClient: HttpClient,
                private readonly log: Logger) {
    }

    async getPresetIdByName(presetName: string) {
        this.log.info(`Getting preset ID by name: [${presetName}]`);
        const allPresets = await this.httpClient.getRequest('sast/presets') as [{ name: string, id: number }];
        const currentPresetName = this.config.presetName.toUpperCase();
        let result: number = 0;
        for (const preset of allPresets) {
            if (preset.name.toUpperCase() === currentPresetName) {
                result = preset.id;
                break;
            }
        }

        if (!result) {
            throw Error(`Could not resolve preset ID from preset Name: ${presetName}`);
        }

        return result;
    }

    getScanSettings(projectId: number) {
        this.log.info('Getting scan settings.');
        return this.httpClient.getRequest(`sast/scanSettings/${projectId}`);
    }

    async createScan(projectId: number) {
        const request: ScanRequest = {
            projectId,
            isIncremental: this.config.isIncremental,
            isPublic: this.config.isPublic,
            forceScan: this.config.forceScan,
            comment: this.config.comment
        };

        const scan = await this.httpClient.postRequest('sast/scans', request);
        this.scanId = scan.id;

        this.stopwatch.start();
        return scan.id;
    }

    getScanStatistics(scanId: number) {
        return this.httpClient.getRequest(`sast/scans/${scanId}/resultsStatistics`);
    }

    updateScanSettings(request: UpdateScanSettingsRequest) {
        this.log.info('Updating scan settings.');
        return this.httpClient.postRequest('sast/scanSettings', request);
    }

    async waitForScanToFinish() {
        this.log.info('Waiting for CxSAST scan to finish.');

        try {
            const waiter = new Waiter();
            const lastStatus = await waiter.waitForTaskToFinish(this.checkIfScanFinished, this.logWaitingProgress);

            if (SastClient.isFinishedSuccessfully(lastStatus)) {
                this.log.info('SAST scan successfully finished.');
            } else {
                this.log.info(`SAST scan status: ${lastStatus.stage.value}, details: ${lastStatus.stageDetails}`);
            }
        } catch (e) {
            this.log.info(`Waiting for CxSAST scan has reached the time limit (${Waiter.PollingSettings.masterTimeoutMinutes} minutes).`);
        }
    }

    private checkIfScanFinished = () => {
        return new Promise<ScanStatus>((resolve, reject) => {
            this.httpClient.getRequest(`sast/scansQueue/${this.scanId}`)
                .then((scanStatus: ScanStatus) => {
                    if (SastClient.isInProgress(scanStatus)) {
                        reject(scanStatus);
                    } else {
                        resolve(scanStatus);
                    }
                });
        });
    };

    private logWaitingProgress = (scanStatus: ScanStatus) => {
        const elapsed = this.stopwatch.getElapsed();
        const stage = scanStatus && scanStatus.stage ? scanStatus.stage.value : 'n/a';
        this.log.info(`Waiting for SAST scan results. Elapsed time: ${elapsed}. ${scanStatus.totalPercent}% processed. Status: ${stage}.`);
    };

    private static isFinishedSuccessfully(status: ScanStatus) {
        return status.stage.value === ScanStage.Finished ||
            status.stageDetails === SastClient.scanCompletedDetails;
    }

    private static isInProgress(scanStatus: ScanStatus) {
        let result = false;
        if (scanStatus && scanStatus.stage) {
            const stage = scanStatus.stage.value;
            result =
                stage !== ScanStage.Finished &&
                stage !== ScanStage.Failed &&
                stage !== ScanStage.Canceled &&
                stage !== ScanStage.Deleted &&
                scanStatus.stageDetails !== SastClient.scanCompletedDetails;
        }
        return result;
    }
}