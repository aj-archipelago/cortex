import json
import uvicorn
from fastapi import FastAPI, HTTPException, Request
from worker import ModelWorker, JobError, SETTLED_HEADERS

app = FastAPI()
worker = ModelWorker()


@app.on_event("startup")
async def startup():
    await worker.start()


@app.on_event("shutdown")
async def shutdown():
    await worker.close()


@app.get("/health")
async def health():
    if not worker.ready or not worker.process or not worker.process.is_alive():
        raise HTTPException(503, "Model unavailable")
    return {"ready": True, "busy": worker.busy}


@app.get("/")
@app.post("/")
async def root(request: Request):
    if worker.busy or not worker.ready:
        raise HTTPException(429, "Worker busy; no job accepted", headers={"Retry-After": "2"})
    try:
        params = await request.json() if request.method == "POST" else dict(request.query_params)
    except json.JSONDecodeError:
        raise HTTPException(400, "Invalid JSON body", headers=SETTLED_HEADERS) from None
    if not isinstance(params, dict) or not isinstance(params.get("fileurl"), str) or not params["fileurl"]:
        raise HTTPException(400, "fileurl parameter is required", headers=SETTLED_HEADERS)
    try:
        return await worker.run(params, request.is_disconnected)
    except JobError as error:
        raise HTTPException(error.status, str(error), headers=SETTLED_HEADERS if not worker.busy else {}) from None


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
