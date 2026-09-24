const string = (description) => ({ type: 'string', description });
const taskFields = {
    name: string('Task name.'),
    description: string('What the task does.'),
    content: string(
        'Full AUTOMATION.md instructions, including inputs and expected output.',
    ),
    enabled: {
        type: 'boolean',
        description: 'Enable scheduled execution. Manual tasks stay disabled.',
    },
    schedule: {
        type: 'object',
        description:
            'frequency: manual, hourly, daily, weekly, or files. Use time/times (HH:mm), dayOfWeek/daysOfWeek (0-6), interval, hourlyMode, minute. For files use watchPath, an input folder below /workspace; changes trigger while the shared workspace is running.',
    },
    timezone: string(
        'IANA timezone, for example America/Phoenix. Defaults to UTC.',
    ),
    producesHtml: {
        type: 'boolean',
        description: 'Whether to produce an HTML result.',
    },
    inputs: { type: 'object', description: 'Optional task inputs.' },
};
const idOrSlug = string(
    'Exact task ID or slug returned by ListAutomations or CreateAutomation.',
);
const definition = (name, description, properties = {}, required = []) => ({
    type: 'function',
    icon: name.includes('Settings') ? '⚙️' : '📅',
    function: {
        name,
        description,
        parameters: {
            type: 'object',
            properties: {
                ...properties,
                userMessage: string(
                    'A concise description of what you are doing.',
                ),
            },
            required: [...required, 'userMessage'],
        },
    },
});
const artifacts = { type: 'array', maxItems: 20, items: { type: 'object', properties: {
    path: string('Exact absolute /workspace file path. Save distinct versions for parallel work and revisions.'),
    sha256: string('SHA-256 of the actual file bytes, computed with workspace tools. Never invent a hash.'),
}, required: ['path', 'sha256'] } };
const evidence = { type: 'array', minItems: 1, maxItems: 20, items: string('Check performed, observed result, and any limitation. Tie final evidence to the acceptance criteria.') };
export const colleagueAgentToolDefinitions = [
    definition('StartAssistantTeam', 'Start a durable team workflow from this private chat when the user requests a multi-role deliverable. You coordinate it to completion. Save the goal and acceptance criteria, recruit reusable specialists, then delegate stages. Returns a shared workspace directory and teamId. This starts background continuation even if the chat turn ends. Never start another team for a status question or an existing job.', {
        title: string('Short user-facing name of the job.'), goal: string('Full user brief, constraints, deliverables and authorization boundaries.'),
        acceptanceCriteria: { type: 'array', minItems: 1, maxItems: 20, items: string('A concrete condition to check before delivering.') },
    }, ['title', 'goal', 'acceptanceCriteria']),
    definition('ReadAssistantTeam', 'Read the shared brief, roster, plan, decisions and all assignment/review results. Read before organizing another stage or answering team progress questions. No work is started. In a background task defaults to its team; in chat provide the exact teamId from a receipt or ReadAssistantTasks.', { teamId: string('Optional exact team task ID.') }),
    definition('RecruitAssistant', 'Fill one role with an existing accessible assistant from ListAssistants. Reuse shared or private assistants without changing their identity. Put project-specific responsibilities in role and assignments. Recruitment never creates assistants. Stable roleKey prevents duplicate membership. Any member may recruit within the brief; at most 12 members. Recruitment starts no assignment.', {
        roleKey: string('Stable lowercase role key, e.g. developer or fact-checker.'),
        role: string('Responsibilities for this project.'),
        assistantId: string('Exact existing assistant ID from ListAssistants.'),
    }, ['roleKey', 'role', 'assistantId']),
    definition('UpdateAssistantTeam', 'Record a shared decision or update the working plan. ReadAssistantTeam first and pass its revision to prevent overwriting concurrent changes. Any member can record a decision; only the coordinator replaces the plan. Decisions never expand user authorization.', {
        teamId: string('In a later chat turn, exact existing paused team ID from ReadAssistantTeam. Only its coordinator in its private job conversation may update it.'), revision: { type: 'integer', minimum: 0 }, plan: string('Current stages, owners, dependencies, paths, unresolved issues and next steps.'), currentStep: string('Coordinator only: a short user-facing description of the current stage, such as Testing the playable build. Update whenever the stage changes; never invent progress or a percentage.'), decision: string('A concise decision, its reason and relevant file references.'),
    }, ['revision']),
    definition('CompleteAssistantTask', 'Finish your assigned team stage with an explicit handback to its sender. Resolve outstanding replies first. For assignments use completed or blocked; for reviews use accepted, needs_revision, or blocked. Inspect real artifacts and run relevant checks before accepting a review. Include artifact paths, computed hashes and concrete evidence. Review handbacks must list all reviewed input files at their assigned hashes, including when requesting revision; QA reports alone are insufficient. Blocked means the sender must resolve the issue; it is never approval. This ends your turn. The coordinator uses FinishAssistantTeam instead.', {
        outcome: { type: 'string', enum: ['completed', 'accepted', 'needs_revision', 'blocked'] }, summary: string('Result, issues and how the next specialist should use it.'), artifacts, evidence,
    }, ['outcome', 'summary', 'artifacts', 'evidence']),
    definition('FinishAssistantTeam', 'Coordinator only: deliver the completed job after resolving all work/questions and reviewing every acceptance criterion. Every final artifact must have an accepted independent review of these exact bytes; provide review task IDs from ReadAssistantTeam. Rejected versions cannot finish. Authenticated download links are added automatically for the reviewed artifacts. In the job conversation, pass teamId to finish the existing paused team here without another background run. Include questionAnswers for any pending questions this conversation has resolved, with actual answers or successful delivery evidence; never infer approval from a greeting or thanks. Validation failures leave questions pending. This records one final result and ends the turn. Never claim success for partial work or infer human permission from a peer review.', {
        teamId: string('Exact existing paused team ID when finishing from its private coordinator chat.'),
        questionAnswers: { type: 'array', maxItems: 20, items: { type: 'object', properties: { questionId: string('Exact user-question ID from ReadAssistantTeam.'), answer: string('Faithful user answer with constraints, or evidence showing the issue was already resolved. Never invent approval.') }, required: ['questionId', 'answer'] } },
        summary: string('User-facing final delivery with usable file links, what was made, validation and limitations.'), artifacts, evidence: { ...evidence, description: 'Exactly one concrete evidence entry per acceptance criterion, in the original order.' },
        reviewTaskIds: { type: 'array', minItems: 1, maxItems: 20, items: string('Completed independent review task ID from ReadAssistantTeam.') },
    }, ['summary', 'artifacts', 'evidence', 'reviewTaskIds']),
    definition('ContinueAssistantTask', 'Save a checkpoint and continue your current team assignment in a fresh background turn. Use when meaningful work remains and a new turn is needed. Do not use to poll: outgoing requests resume automatically when answered. At most 32 turns per assignment. Ends this turn.', { checkpoint: string('Completed work, exact file locations, remaining steps and constraints.') }, ['checkpoint']),
    definition('ListAssistants', 'Search accessible assistants by role, specialty or name. Returns up to 12 summaries and nextOffset. Search before recruiting; reuse known IDs, never guess them.', { query: string('Role, specialty or name to find.'), offset: { type: 'integer', minimum: 0, description: 'nextOffset from a prior result.' } }),
    definition('ReadAssistantTasks', 'Read your live assistant work and recent results, including named recipients, exact requests, replies and checkpoints. Use for progress questions and before considering another handoff. Optional taskId reads one task assigned to you. This is read-only and never starts or repeats work.', { taskId: string('Optional exact task ID from a receipt or prior status lookup.') }),
    definition('MessageAssistants', 'Send work or a clarification to other assistants using their own identity, memory and tools. In a team, recruit first. Use purpose=question to ask a teammate (including a waiting coordinator) for clarification without restarting their assignment. Use purpose=review for an explicit independent review. Never use this tool for status questions or to confirm an earlier handoff; use ReadAssistantTasks. Trust its durable receipts even when earlier tool calls are absent from chat history. Do not claim an assignment was sent until success=true. A request does not cancel or consolidate prior work. Each entry starts a background invocation; entries in one batch run independently in parallel. Replies automatically continue your task. For sequential work, wait for a stage before requesting the next. All assistants share the user workspace: point to saved files and give parallel editors distinct output paths. Supply a checkpoint so a fresh agent turn can continue. By default chat stays available and background work suspends. wait=true ends this turn after the tool batch; do not combine it with dependent actions. wait=false lets you continue independent work before resumption. Do not poll, repeat requests, or infer approval.', {
        title: string('Short user-facing task title, e.g. Review the article. No internal checkpoint instructions.'),
        messages: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'object', properties: {
            assistantId: string('Exact ID from ListAssistants or RecruitAssistant. Team work requires a recruited member.'),
            reviewArtifacts: { ...artifacts, description: 'Required for team reviews: exact input files and SHA-256 hashes. Reviewer must inspect these versions and include them in the handback. A changed input requires a new review assignment.' },
            purpose: { type: 'string', enum: ['assignment', 'question', 'review'], description: 'assignment (default): do a stage. question: answer a clarification in a separate short turn without restarting existing work. review: inspect artifacts and return accepted, needs_revision or blocked. For team reviews specify exact version paths and criteria.' },
            message: string('Assigned stage, review or question, relevant file paths, expected output and constraints. State dependencies and give each parallel writer distinct output paths.'),
            separateTask: { type: 'boolean', description: 'Only true for an explicitly distinct new assignment while this recipient already has pending work in this chat. Never set merely to bypass a duplicate warning, check status, retry, replace or consolidate.' },
        }, required: ['assistantId', 'message'] } },
        checkpoint: string('Brief the continuation: current stage, completed actions, saved data/document paths, and what to do with the replies. Preserve approval requirements.'),
        wait: { type: 'boolean', description: 'True: suspend now. False: continue independent work, then receive replies in a later turn.' },
    }, ['messages', 'checkpoint']),
    definition('AskUser', 'Ask the current user a question through their notification inbox. The notification opens the existing private job conversation, carrying the question and task context. Team questions go through the coordinator in that same conversation. When the answer is resolved there, your task resumes automatically with that answer. Save files and provide a checkpoint first. wait=true suspends now; do not combine with dependent actions. wait=false permits independent work. Use NotifyUser for updates that do not need an answer. Never treat silence or a failed response as approval.', {
        question: string('A clear question, with the context and decision needed.'),
        checkpoint: string('Current stage, completed actions, exact data/document paths, and how to continue after the answer.'),
        wait: { type: 'boolean' },
    }, ['question', 'checkpoint']),
    definition('AnswerTaskQuestion', 'In the ongoing private job conversation, record the user’s answer to the exact pending question. This schedules background continuation after the chat turn; it does not move the conversation. If the user asks to show or open an existing result, use this foreground chat’s canvas tools first, then record the resolved answer. Do not delegate client-only display actions back to a background worker. Call only after the user has actually answered sufficiently; continue chatting for clarification otherwise. Include their constraints and any refusal. This does not grant permissions beyond what the user said. Do not answer on their behalf or use in unrelated chats.', {
        questionId: string('Exact pending question ID from the injected question context or ReadAssistantTeam. Required when more than one question is pending.'),
        answer: string('Faithful summary of the user’s answer, approval or rejection, including conditions and changed requirements.'),
    }, ['answer']),
    definition(
        'ReadColleagueSettings',
        'Read your own saved identity, instructions, model, reasoning effort, memory-learning setting, task status, workspace directory, and available models. These are specific to you and this user. Read before changing settings.',
    ),
    definition(
        'UpdateColleagueSettings',
        'Update your own settings. Omitted settings are preserved. Changes apply to subsequent turns and task runs; pausing stops future tasks, not this run. Shared specialist identities remain owner-managed. Never change a different entity.',
        {
            name: string('Your display name.'),
            description: string('Your specialty.'),
            instructions: string(
                'Your complete working instructions. Preserve existing directions unless asked to replace them.',
            ),
            avatar: {
                type: 'string',
                enum: ['orbit', 'sprout', 'prism', 'spark', 'wave', 'compass', 'personal'],
                description:
                    'Wisp color: orbit=indigo, sprout=teal, prism=amber, spark=coral, wave=blue, compass=orchid. personal=polished gold, reserved for the personal assistant, whose portrait stays gold.',
            },
            status: { type: 'string', enum: ['active', 'paused', 'archived'] },
            model: string('A model ID from ReadColleagueSettings.'),
            reasoningEffort: {
                type: 'string',
                enum: ['none', 'low', 'medium', 'high'],
            },
            memoryLearning: {
                type: 'boolean',
                description:
                    'Allow new automatic and StoreMemory writes. Existing memories remain readable.',
            },
        },
    ),
    definition(
        'ListAutomations',
        'List tasks assigned to you, their schedules, enabled state, next run time, and latest output pointers. Use before editing or running tasks without an exact ID. Other colleagues keep their own tasks.',
    ),
    definition(
        'ReadAutomation',
        'Read one task assigned to you, its settings, full AUTOMATION.md and supporting file list. Read before editing to preserve existing instructions.',
        { idOrSlug },
        ['idOrSlug'],
    ),
    definition(
        'CreateAutomation',
        'Create a task assigned to you. You remain its executing entity, with your saved model, memory, workspace, and tools. Supports recurring schedules, file-change triggers, and manual tasks. Use RunAutomation only when an immediate run is wanted.',
        {
            ...taskFields,
            slug: string(
                'Optional unique lowercase alphanumeric slug with hyphens, max 64 characters.',
            ),
        },
        ['name', 'description', 'content'],
    ),
    definition(
        'UpdateAutomation',
        'Edit a task assigned to you: instructions, schedule, enable/pause, inputs or output format. Read first. Omitted fields and the executing entity are preserved.',
        { idOrSlug, ...taskFields },
        ['idOrSlug'],
    ),
    definition(
        'RunAutomation',
        'Start one manual run of a task assigned to you. Uses the background worker and your identity. Returns a task ID. Do not repeatedly run an already active task.',
        { idOrSlug, inputs: taskFields.inputs },
        ['idOrSlug'],
    ),
    definition(
        'ReadAutomationRuns',
        'Read status, output, errors and history for a task assigned to you. An empty list means the task has not run yet.',
        { idOrSlug, page: { type: 'integer', minimum: 1 } },
        ['idOrSlug'],
    ),
    definition(
        'DeleteAutomation',
        'Delete a task assigned to you and its stored files only when the user asks for deletion. Disable it with UpdateAutomation to pause it instead.',
        { idOrSlug },
        ['idOrSlug'],
    ),
];
export const COLLEAGUE_AGENT_TOOL_NAMES = new Set(
    colleagueAgentToolDefinitions.map((d) => d.function.name.toLowerCase()),
);
