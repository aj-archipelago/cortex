import ModelPlugin from "./modelPlugin.js";
import fs from "fs";
import FormData from "form-data";
import logger from "../../lib/logger.js";
import { alignSubtitles, deleteTempPath, downloadFile, getMediaChunks } from "../../lib/util.js";
import CortexRequest from "../../lib/cortexRequest.js";
import { publishRequestProgress } from "../../lib/redisSubscription.js";

const OFFSET_CHUNK = 500; //seconds of each chunk offset, only used if helper does not provide

function convertToSrt(timestamps) {
  var srt = '';
  for (var i = 0; i < timestamps.length; i++) {
      var start = new Date(timestamps[i].start * 1000).toISOString().substr(11, 12);
      var end = new Date(timestamps[i].end * 1000).toISOString().substr(11, 12);
      srt += `${i + 1}\n${start.replace('.', ',')} --> ${end.replace('.', ',')}\n${timestamps[i].word}\n\n`;
  }
  return srt;
}

function convertToVtt(timestamps) {
  var vtt = 'WEBVTT\n\n';
  for (var i = 0; i < timestamps.length; i++) {
      var start = new Date(timestamps[i].start * 1000).toISOString().substr(11, 12);
      var end = new Date(timestamps[i].end * 1000).toISOString().substr(11, 12);
      vtt += `${start} --> ${end}\n${timestamps[i].word}\n\n`;
  }
  return vtt;
}

class NeuralSpacePlugin extends ModelPlugin {
  constructor(pathway, model) {
    super(pathway, model);
    this.pathwayResolver = null;
  }

async execute(text, parameters, prompt, cortexRequest) {
    const { responseFormat, file, language } = parameters;

    let chunks = [];
    let offsets = [];

    try {
        const { pathwayResolver } = cortexRequest;

        const { requestId } = pathwayResolver;

        const mediaChunks = await getMediaChunks(file, requestId);

        if (!mediaChunks || !mediaChunks.length) {
            throw new Error(
                `Error in getting chunks from media helper for file ${file}`
            );
        }

        const uris = mediaChunks.map((chunk) => chunk?.uri || chunk);
        offsets = mediaChunks.map((chunk, index) => chunk?.offset || index * OFFSET_CHUNK);



        let totalCount = uris.length*2; // [download, request] jobs per chunk
        let completedCount = 0;

        const sendProgress = () => {
          completedCount++;
          if(completedCount >= totalCount) return;

          const progress = completedCount / totalCount;
          logger.info(`Progress for ${requestId}: ${progress}`);

          publishRequestProgress({
              requestId,
              progress,
              data: null,
          });
        }

        for (let i = 0; i < uris.length; i++) {
            const uri = uris[i];
            try {
                const chunk = await downloadFile(uri);
                chunks.push(chunk);
                sendProgress();
            } catch (err) {
                logger.error(`Error downloading chunk: ${err}`);
                throw err;
            }
        }

        const jobs = [];

        for (const chunk of chunks) {
            const cortexRequest = new CortexRequest({ pathwayResolver });
            cortexRequest.url = this.requestUrl();

            const formData = new FormData();
            formData.append('files', fs.createReadStream(chunk));
            const configObj = {
              file_transcription: {
                  mode: "advanced",
              },
            };
            if(language){
              configObj.file_transcription.language_id = language;
            }
            formData.append("config",JSON.stringify(configObj));

            cortexRequest.data = formData;
            cortexRequest.params = {};
            cortexRequest.headers = {
                ...cortexRequest.headers,
                ...formData.getHeaders(),
            };

            const result = await this.executeRequest(cortexRequest);

            const jobId = result?.data?.jobId;
            if (!jobId) {
                logger.error(`Error in creating job: ${JSON.stringify(result)}`);
                return;
            }
            logger.info(`Job created successfully with ID: ${jobId}`);
            jobs.push(jobId);
        }

        return await this.checkJobStatus(jobs, pathwayResolver, sendProgress, responseFormat, offsets);
    } catch (error) {
        logger.error(`Error occurred while executing: ${error}`);
        throw error;
    } finally {
        for (const chunk of chunks) {
            try {
                await deleteTempPath(chunk);
            } catch (error) {
                // Ignore error
                logger.error(`Error deleting temp file: ${error}`);
            }
        }
    }
}

  async checkJobStatus(jobs, pathwayResolver, sendProgress, responseFormat, offsets) {
    const textResults = [];
    const timestampResults = [];
    for (let i=0; i<jobs.length; i++) {
      const jobId = jobs[i];
      const result = await this.getJobStatus(jobId, pathwayResolver);
      const text = result.data.result.transcription.channels[0].transcript;
      textResults.push(text);
      timestampResults.push(result.data.result.transcription.channels[0].timestamps);
      sendProgress();
    }

    if(responseFormat){
      const output = timestampResults.map(t => responseFormat === 'srt' ? convertToSrt(t) : convertToVtt(t));
      return alignSubtitles(output, responseFormat, offsets);
    }

    return textResults.join(" ").trim();
  }

  async getJobStatus(jobId, pathwayResolver) {
    const cortexRequest = new CortexRequest({ pathwayResolver });
    cortexRequest.url = `${this.requestUrl()}/${jobId}`;
    cortexRequest.method = "GET";
    const result = await this.executeRequest(cortexRequest);

    const status = result?.data?.status;
    if(!status) {
      throw new Error(`Error in getting job status: ${result}`);
    }

    if (status === "Completed") {
      return result;
    }

    if(status === "Failed" ) {
      throw new Error(`Job failed with error: ${result.data.error}`);
    }else {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      return this.getJobStatus(jobId, pathwayResolver);
    }
  }
}

export default NeuralSpacePlugin;
