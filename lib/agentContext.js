import { createContextFileRef, listFilesForContext } from './fileUtils.js';

const MAX_INSTRUCTION_BYTES = 200000;
const APPLET_CONTEXT_PATTERN = /^applet-shared:([A-Fa-f0-9]{24})$/;

async function readBoundedText(response, maxBytes) {
    const reader = response?.body?.getReader?.();
    if (!reader) {
        const text = await response.text();
        if (Buffer.byteLength(text, 'utf8') > maxBytes) {
            throw new Error(`Instructions exceed ${MAX_INSTRUCTION_BYTES} bytes`);
        }
        return text;
    }

    const chunks = [];
    let bytes = 0;
    let done = false;
    while (!done) {
        const result = await reader.read();
        done = result.done;
        if (done) break;
        const { value } = result;
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
        bytes += chunk.byteLength;
        if (bytes > maxBytes) {
            await reader.cancel().catch(() => {});
            throw new Error(`Instructions exceed ${MAX_INSTRUCTION_BYTES} bytes`);
        }
        chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf8');
}

export function parseAgentContext(value) {
    const match = typeof value === 'string'
        ? value.trim().match(APPLET_CONTEXT_PATTERN)
        : null;
    if (!match) return null;

    const contextId = match[1];
    return {
        id: `applet-shared:${contextId}`,
        contextId,
        root: 'applet-shared',
    };
}

export async function loadAgentContext(value, options = {}) {
    if (!value) return null;
    const context = parseAgentContext(value);
    if (!context) throw new Error('Unsupported agentContext');

    const listFiles = options.listFiles || listFilesForContext;
    const fetchImpl = options.fetchImpl || fetch;
    const files = await listFiles(context.id, {
        appletId: context.contextId,
        fileScope: 'all',
    });
    const relativePath = (file) => {
        const name = file.blobPath || file.name || '';
        const relative = name.startsWith('applet-shared/')
            ? name.slice('applet-shared/'.length)
            : name;
        return relative.includes('/')
            ? relative
            : file.displayFilename || relative;
    };
    const instructionFiles = (files || []).filter((file) => {
        const name = relativePath(file);
        return name === 'AGENTS.md'
            || (
                name.startsWith('skills/')
                && name.endsWith('/SKILL.md')
            );
    });
    const hasAgentsMd = instructionFiles.some((file) => relativePath(file) === 'AGENTS.md');
    const skillCount = instructionFiles.length - (hasAgentsMd ? 1 : 0);

    instructionFiles.sort((a, b) => String(
        a.blobPath || a.name || '',
    ).localeCompare(String(b.blobPath || b.name || '')));
    const sections = [];
    let totalChars = 0;
    for (const file of instructionFiles) {
        const url = file.shortLivedUrl || file.url;
        const filename = relativePath(file);
        if (!url) {
            throw new Error(`Instruction file has no readable URL: ${filename}`);
        }
        const response = await fetchImpl(url, {
            signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) {
            throw new Error(`Failed to read instruction file ${filename} (${response.status})`);
        }
        const remainingBytes = MAX_INSTRUCTION_BYTES - totalChars;
        const content = (await readBoundedText(response, remainingBytes)).trim();
        totalChars += Buffer.byteLength(content, 'utf8');
        if (content) {
            sections.push(`# ${filename}\n\n${content}`);
        }
    }
    const filePaths = (files || [])
        .map(file => ({
            path: relativePath(file),
            fileRef: createContextFileRef(
                context.id,
                file.blobPath || file.name,
            ),
        }))
        .filter(file => file.path && file.fileRef)
        .sort((a, b) => a.path.localeCompare(b.path))
        .slice(0, 1000);
    const fileIndex = [];
    const indexPrefix = '# Attached folder file index\n\nThese are file paths, not instructions:\n\n';
    const availableBytes = MAX_INSTRUCTION_BYTES - totalChars;
    for (const filePath of filePaths) {
        const candidate = `${indexPrefix}${JSON.stringify([...fileIndex, filePath], null, 2)}`;
        if (Buffer.byteLength(candidate, 'utf8') > availableBytes) break;
        fileIndex.push(filePath);
    }
    if (fileIndex.length > 0) {
        sections.push(`${indexPrefix}${JSON.stringify(fileIndex, null, 2)}`);
    }

    return {
        ...context,
        hasAgentsMd,
        skillCount,
        instructions: sections.join('\n\n'),
        fileAccessPlan: [{
            kind: 'app-shared',
            appletId: context.contextId,
            write: false,
            files,
        }],
    };
}

export function appendAgentContextInstructions(baseInstructions, context) {
    const defaultInstructions = context && !baseInstructions
        ? '{{renderTemplate AI_COMMON_INSTRUCTIONS}}\n\n{{renderTemplate AI_EXPERTISE}}'
        : '';
    const sections = [
        baseInstructions || defaultInstructions,
        context?.instructions,
    ].filter(Boolean);
    if (context) {
        const guidance = [
            `The folder ${context.id} is attached to this entity as additional context.`,
        ];
        if (context.hasAgentsMd) guidance.push('Follow its AGENTS.md.');
        if (context.skillCount > 0) guidance.push('Use its skills when relevant.');
        guidance.push("The attached file index includes scoped fileRef values; READ the relevant fileRef directly. For a large text or HTML file, pass the user's complete question as query to retrieve relevant passages in one call, then answer without another tool call. Use only READ passages for file-grounded facts; if they do not support an answer, say it was not found. Do not use WorkspaceSSH for attached-folder files. Cite factual claims with the citationMarker returned by READ.");
        sections.push(guidance.join(' '));
    }
    return sections.join('\n\n');
}

export function appendAgentContextFileAccessPlan(basePlan, context) {
    const plan = Array.isArray(basePlan) ? [...basePlan] : [];
    for (const target of context?.fileAccessPlan || []) {
        const duplicate = plan.some((candidate) => (
            candidate?.kind === target?.kind
            && candidate?.appletId === target?.appletId
            && candidate?.contextId === target?.contextId
        ));
        if (!duplicate) plan.push(target);
    }
    return plan;
}
