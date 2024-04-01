import uvicorn
from fastapi import FastAPI, HTTPException, Request
from uuid import uuid4
import os
import asyncio
import whisper
from whisper.utils import get_writer
from fastapi.encoders import jsonable_encoder
import time

model_download_root = './models'
try:
    model = whisper.load_model("large", download_root=model_download_root) #large, tiny
except Exception as e:
    print(f"Error loading model: {e}")
    raise

# Create a semaphore with a limit of 1
semaphore = asyncio.Semaphore(1)

app = FastAPI()

save_directory = "./tmp"  # folder for downloaded files
os.makedirs(save_directory, exist_ok=True)


def delete_tmp_file(file_path):
    try:
        os.remove(file_path)
        print(f"Temporary file '{file_path}' has been deleted.")
    except OSError as e:
        print(f"Error: {e.strerror}")

def transcribe(params):
    if 'fileurl' not in params:
        raise HTTPException(status_code=400, detail="fileurl parameter is required")
    
    fileurl = params["fileurl"]

    # word_timestamps bool, default True
    word_timestamps = True
    if 'word_timestamps' in params: #parse as bool
        word_timestamps = False if params['word_timestamps'] == 'False' else True

    decode_options = {}
    if 'language' in params:
        decode_options["language"] = params["language"]
        print(f"Transcription language set as {decode_options['language']}")

    print(f"Transcribing file {fileurl} with word_timestamps={word_timestamps}")
    start_time = time.time()
    try:
        result = model.transcribe(fileurl, word_timestamps=word_timestamps, **decode_options)
    except Exception as e:
        print(f"Error during transcription: {e}")
        raise
    end_time = time.time()
    execution_time = end_time - start_time
    print("Transcribe execution time:", execution_time, "seconds")

    srtpath = os.path.join(save_directory, str(uuid4()) + ".srt")

    print(f"Saving transcription as : {srtpath}")
    writer = get_writer("srt", save_directory)

    writer_args = {'highlight_words': False, 'max_line_count': None, 'max_line_width': None, 'max_words_per_line': None}
    if 'highlight_words' in params: #parse as bool
        writer_args['highlight_words'] = params['highlight_words'] == 'True'
    if 'max_line_count' in params: #parse as int
        writer_args['max_line_count'] = int(params['max_line_count'])
    if 'max_line_width' in params: #parse as int
        writer_args['max_line_width'] = int(params['max_line_width'])
    if 'max_words_per_line' in params: #parse as int
        writer_args['max_words_per_line'] = int(params['max_words_per_line'])

    # if and only if fileurl and word_timestamps=True, max_words_per_line=1
    if fileurl and word_timestamps and len(params) <= 2:
        writer_args['max_words_per_line'] = 1

    try:
        writer(result, srtpath, **writer_args)
    except Exception as e:
        print(f"Error while writing transcription: {e}")
        raise

    with open(srtpath, "r") as f:
        srtstr = f.read()

    # clean up tmp out files
    delete_tmp_file(srtpath)

    print(f"Transcription of file {fileurl} completed")
    return srtstr


async def get_params(request: Request):
    params = {}
    if request.method == "POST":
        body = jsonable_encoder(await request.json())
        params = body
    else:
        params = dict(request.query_params)
    return params

@app.get("/")
@app.post("/")
async def root(request: Request):
    if semaphore.locked():
        raise HTTPException(status_code=429, detail="Too Many Requests")
    
    params = await get_params(request)
    async with semaphore:
        try:
            result = await asyncio.to_thread(transcribe, params)
            return result
        except HTTPException as e:
            raise e
        except Exception as e:
            print(f"Internal Server Error: {e}")
            raise HTTPException(status_code=500, detail="Internal Server Error")

if __name__ == "__main__":
    print("Starting APP Whisper server", flush=True)
    uvicorn.run(app, host="0.0.0.0", port=8000)