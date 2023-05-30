import uvicorn
from fastapi import FastAPI
import stable_whisper
from uuid import uuid4
import requests
import os

model = stable_whisper.load_model('large') 

app = FastAPI()

save_directory = "./tmp" # folder for downloaded files
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



@app.get("/")
async def root(fileurl: str):
    if not fileurl:
        return "No fileurl given!"
    
    print(f"Downloading file from: {fileurl}")
    [unique_file_name, save_path] = download_remote_file(fileurl, save_directory)
    print(f"Downloaded file saved as: {unique_file_name}")
    
    print(f"Transcribing file")
    result = model.transcribe(save_path)

    
    srtpath = os.path.join(save_directory, str(uuid4()) + ".srt")

    print(f"Saving transcription as : {srtpath}")
    result.to_srt_vtt(srtpath, segment_level=False)

    with open(srtpath,"r") as f:
        srtstr = f.read()

    # clean up tmp files
    delete_tmp_file(save_path)
    delete_tmp_file(srtpath)

    print(f"Transcription done.")
    return srtstr


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)