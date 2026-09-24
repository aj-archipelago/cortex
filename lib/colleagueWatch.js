import path from 'node:path';
export function validateWatchPath(value) {
    if (
        typeof value !== 'string' ||
        value.length > 512 ||
        /[\x00-\x1f]/.test(value)
    )
        throw new Error('Invalid watch path');
    const normalized = path.posix.normalize(value);
    if (
        !normalized.startsWith('/workspace/') ||
        normalized === '/workspace/' ||
        normalized.startsWith('/workspace/files') ||
        normalized.split('/').some((part) => part.startsWith('.'))
    )
        throw new Error(
            'Choose a folder inside /workspace, excluding cloud mounts and hidden folders',
        );
    return normalized;
}
export function watchCommand(value) {
    const target = validateWatchPath(value);
    const script = `import os,json,hashlib\np=${JSON.stringify(target)}\nrows=[]\nif os.path.islink(p) or not os.path.realpath(p).startswith('/workspace/'): raise ValueError('Watch root must stay within workspace')\nif os.path.exists(p):\n for root,dirs,files in os.walk(p,followlinks=False):\n  dirs[:]=sorted(d for d in dirs if not d.startswith('.') and d not in ['node_modules','__pycache__'] and not os.path.islink(os.path.join(root,d)))\n  for name in sorted(files):\n   f=os.path.join(root,name)\n   if name.startswith('.') or os.path.islink(f): continue\n   st=os.stat(f); rows.append([os.path.relpath(f,p),st.st_size,st.st_mtime_ns])\n   if len(rows)>5000: raise ValueError('Watch folder exceeds 5000 files')\nprint(hashlib.sha256(json.dumps(rows,sort_keys=True).encode()).hexdigest())`;
    return `python3 -c 'import base64; exec(base64.b64decode("${Buffer.from(script).toString('base64')}"))'`;
}
