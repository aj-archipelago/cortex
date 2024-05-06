import ModelPlugin from "./modelPlugin.js";
import fs from "fs";
import FormData from "form-data";
import logger from "../../lib/logger.js";
import { downloadFile, getMediaChunks } from "../../lib/util.js";
import CortexRequest from "../../lib/cortexRequest.js";

// const OFFSET_CHUNK = 500; //seconds of each chunk offset, only used if helper does not provide

class NeuralSpacePlugin extends ModelPlugin {
  constructor(pathway, model) {
    super(pathway, model);
    this.pathwayResolver = null;
  }

  async execute(text, parameters, prompt, cortexRequest) {
    const { pathwayResolver } = cortexRequest;
    const { file } = parameters;

    const { requestId } = pathwayResolver;

    const chunks = [];

    const mediaChunks = await getMediaChunks(file, requestId);

    if (!mediaChunks || !mediaChunks.length) {
      throw new Error(
        `Error in getting chunks from media helper for file ${file}`
      );
    }

    const uris = mediaChunks.map((chunk) => chunk?.uri || chunk);
    // const offsets = mediaChunks.map(
    //   (chunk, index) => chunk?.offset || index * OFFSET_CHUNK
    // );

    for (let i = 0; i < uris.length; i++) {
      const uri = uris[i];
      try {
        const chunk = await downloadFile(uri);
        chunks.push(chunk);
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
      formData.append("files", fs.createReadStream(chunk));
      formData.append(
        "config",
        JSON.stringify({
          file_transcription: {
            // 'language_id': '{{LANG}}',
            mode: "advanced",
            // 'number_formatting': '{{NUMBER_FORMATTING}}'
          },
        })
      );

      cortexRequest.data = formData;
      cortexRequest.params = {};
      cortexRequest.headers = {
        ...cortexRequest.headers,
        ...formData.getHeaders(),
      };

      const result = await this.executeRequest(cortexRequest);

      const jobId = result?.data?.jobId;
      if (!jobId) {
        logger.error(`Error in creating job: ${result}`);
        return;
      }
      logger.info(`Job created successfully with ID: ${jobId}`);
      jobs.push(jobId);
    }

    const results = await this.checkJobStatus(jobs, pathwayResolver);
    return results.join(" ").trim();
  }

  async checkJobStatus(jobs, pathwayResolver) {
    const results = [];
    for (const jobId of jobs) {
      const result = await this.getJobStatus(jobId, pathwayResolver);
      //result.data.result.transcription.channels[0].transcript
      const text = result.data.result.transcription.channels[0].transcript;
      results.push(text);
    }

    return results;
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
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return this.getJobStatus(jobId, pathwayResolver);
    }
  }
}

export default NeuralSpacePlugin;
