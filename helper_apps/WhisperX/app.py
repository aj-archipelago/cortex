import uvicorn
from fastapi import FastAPI
from uuid import uuid4
import os
import requests
import asyncio
import whisper
from whisper.utils import get_writer
import io

model_download_root = './models'
model = whisper.load_model("large", download_root=model_download_root) #large, tiny


app = FastAPI()

save_directory = "./tmp"  # folder for downloaded files
os.makedirs(save_directory, exist_ok=True)


def download_remote_file(url, save_directory):
    # Generate a unique file name with a UUID
    unique_name = str(uuid4()) + os.path.splitext(url)[-1]
    save_path = os.path.join(save_directory, unique_name)

    # Download the remote file
    response = requests.get(url, stream=True)
    response.raise_for_status()

    # Save the downloaded file with the unique name
    with open(save_path, 'wb') as file:
        for chunk in response.iter_content(chunk_size=8192):
            file.write(chunk)

    return [unique_name, save_path]

def delete_tmp_file(file_path):
    try:
        os.remove(file_path)
        print(f"Temporary file '{file_path}' has been deleted.")
    except OSError as e:
        print(f"Error: {e.strerror}")

def modify_segments(result):
    modified_segments = []
    
    id = 0
    for segment in result["segments"]:
        for word_info in segment['words']:
            word = word_info['word']
            start = word_info['start']
            end = word_info['end']
            
            modified_segment = {} #segment.copy()
            modified_segment['id'] = id
            modified_segment['text'] = word
            modified_segment['start'] = start
            modified_segment['end'] = end
            modified_segments.append(modified_segment)
            id+=1
    
    result["segments"] = modified_segments
    
def transcribe(fileurl):
    print(f"Downloading file from: {fileurl}")
    [unique_file_name, save_path] = download_remote_file(
        fileurl, save_directory)
    print(f"Downloaded file saved as: {unique_file_name}")

    print(f"Transcribing file")
    result = model.transcribe(save_path, word_timestamps=True)

    modify_segments(result)

    srtpath = os.path.join(save_directory, str(uuid4()) + ".srt")

    print(f"Saving transcription as : {srtpath}")
    writer = get_writer("srt", save_directory)
    with open(srtpath, 'w', encoding='utf-8') as file_obj :
        writer.write_result(result, file_obj)

    with open(srtpath, "r") as f:
        srtstr = f.read()

    # clean up tmp files
    delete_tmp_file(save_path)
    delete_tmp_file(srtpath)

    print(f"Transcription done.")
    return srtstr


@app.get("/")
async def root(fileurl: str):
    if not fileurl:
        return "No fileurl given!"

    result = await asyncio.to_thread(transcribe, fileurl)

    return result

if __name__ == "__main__":
    print("Starting APPWhisper server", flush=True)
    uvicorn.run(app, host="0.0.0.0", port=8000)
