from autogen_agentchat.agents import AssistantAgent, CodeExecutorAgent
from autogen_ext.code_executors.local import LocalCommandLineCodeExecutor
import os
from typing import Optional
from autogen_core.tools import FunctionTool
from tools.azure_blob_tools import upload_file_to_azure_blob

#AGENTS
MAGENTIC_ONE_CODER_DESCRIPTION = "A helpful and general-purpose AI assistant that has strong language skills, Python skills, and Linux command line skills."

MAGENTIC_ONE_CODER_SYSTEM_MESSAGE = """You are a helpful AI assistant.
Solve tasks using your coding and language skills.
In the following cases, suggest python code (in a python coding block) or shell script (in a sh coding block) for the user to execute.
    1. When you need to collect info, use the code to output the info you need, for example, browse or search the web, download/read a file, print the content of a webpage or a file, get the current date/time, check the operating system. After sufficient info is printed and the task is ready to be solved based on your language skill, you can solve the task by yourself.
    2. When you need to perform some task with code, use the code to perform the task and output the result. Finish the task smartly.
Solve the task step by step if you need to. If a plan is not provided, explain your plan first. Be clear which step uses code, and which step uses your language skill.
When using code, you must indicate the script type in the code block. The user cannot provide any other feedback or perform any other action beyond executing the code you suggest. The user can't modify your code. So do not suggest incomplete code which requires users to modify. Don't use a code block if it's not intended to be executed by the user.
Don't include multiple code blocks in one response. Do not ask users to copy and paste the result. Instead, use the 'print' function for the output when relevant. Check the execution result returned by the user.
If the result indicates there is an error, fix the error and output the code again. Suggest the full code instead of partial code or code changes. If the error can't be fixed or if the task is not solved even after the code is executed successfully, analyze the problem, revisit your assumption, collect additional info you need, and think of a different approach to try.
When you find an answer, verify the answer carefully. Include verifiable evidence in your response if possible."""


async def get_agents(default_model_client, big_model_client, small_model_client, request_work_dir: Optional[str] = None):

    # Resolve work dir (prefer per-request dir if provided or from env)
    work_dir = request_work_dir or os.getenv("CORTEX_WORK_DIR", "/home/site/wwwroot/coding")
    try:
        # In Azure Functions, ensure /tmp is used for write access if an /app path was set
        if os.getenv("WEBSITE_INSTANCE_ID") and work_dir.startswith("/app/"):
            work_dir = "/tmp/coding"
        os.makedirs(work_dir, exist_ok=True)
    except Exception:
        try:
            work_dir = "/tmp/coding"
            os.makedirs(work_dir, exist_ok=True)
        except Exception:
            pass

    code_executor = LocalCommandLineCodeExecutor(work_dir=work_dir, timeout=300)

    #TOOLS
    upload_file_to_cloud_tool = FunctionTool(upload_file_to_azure_blob, description="Upload files to the cloud. You must use absolute path to reference local files.")

    coder_agent = AssistantAgent(
        "coder_agent",
        model_client=default_model_client,
        description=MAGENTIC_ONE_CODER_DESCRIPTION,
        system_message=MAGENTIC_ONE_CODER_SYSTEM_MESSAGE +  f"""
            Save remote files images, videos, etc. in order to work with them locally. 
            Make sure to log/print everything in code otherwise you will lose the context and cannot debug it. 
            Make sure your code is perfect.
            Never ask for user input or user to do anything.
            Never ask questions.
            Your are expert in coding, do wonders.
            If you need to do advanced stuff you can do a project and run it.
            You can split codes, build projects, run anything, coding is your strength in this task.
            Take actionable verifiable small steps if needed.
            Understand that pitfalls and find ways to overcome them.
            Progress is important, do not get stuck in a loop, keep trying but do not repeat the same steps.
            Current directory might be different from the one you think it is, use absolute path to reference files.
            Code executor working directory is: {work_dir}
            So you can only access files in this directory.
            Always use absolute path to reference files as current directory might be different from the one you think it is.
        """,
    )

    code_executor_agent = CodeExecutorAgent("code_executor", code_executor=code_executor)


    terminator_agent = AssistantAgent(
        "terminator_agent",
        model_client=default_model_client,
        description="A helpful assistant that can terminate.",
        system_message="""You are a helpful assistant that can terminate. 
            Original task must be completed in order to terminate.
            Only output: TERMINATE, if completed.
            If not completed, give the reason instead of TERMINATE.
            Do not ask questions you are the terminator.
            Always output in single line without any other text.
            Do not give empty response.
            In order to terminate:
                - Task must be completed.
                - All referenced local files must have been uploaded to the cloud and their public URLs retrieved and included in the final output.
                - Presenter must have provided the final output.
            All code must have been executed in order to terminate.
            Deliverables must have been provided in order to terminate.
            If you cannot terminate because of same reason after 3 attempts, terminate.
            Example outputs:

            TERMINATE

            TASK NOT COMPLETED: missing missing missing
        """,
    )


    presenter_agent = AssistantAgent(
        "presenter_agent",
        model_client=default_model_client,
        description="A highly skilled and creative presentation specialist, responsible for crafting visually stunning and exceptionally informative final deliverables.",
        system_message="""You are a highly skilled and creative presentation specialist, responsible for crafting visually stunning and exceptionally informative final deliverables.
            Your goal is to transform raw task results into engaging, professional, and visually appealing presentations, primarily using Markdown.
            
            Here's what makes a great presentation:
            - **Captivating Structure**: Start with a compelling summary, followed by well-organized sections with clear headings and subheadings.
            - **Stunning Visuals**: Integrate relevant images, videos, and even diagrams (if applicable and possible via markdown) seamlessly to enhance understanding and engagement. Ensure visuals are high-quality and directly support the content.
            **IMPORTANT: Actively look for `UPLOADED_FILES_SAS_URLS` provided in the input. If images or other visual assets are available via these URLs, you MUST incorporate them into your Markdown presentation. Describe and explain these visuals to the user, providing context and insights.**
            - **Professional Aesthetics**: Utilize Markdown's full capabilities for formatting, including bolding, italics, lists, and tables, to create a clean, readable, and visually pleasing layout. Think about white space and information hierarchy.
            - **Concise & Impactful Language**: Use persuasive and professional language. Avoid jargon where possible, or explain it clearly. Every word should contribute to clarity and impact.
            - **User-Centric Design**: Remember that your output will be directly displayed in a React application. Focus on great UI/UX, ensuring the presentation is intuitive and easy for the end-user to consume.
            - **Complete & Actionable**: Ensure all necessary information from the task is included, and if appropriate, guide the user towards next steps or key takeaways.
            
            Report must be a direct reply to the user's task. You are the final voice to the user, so make it perfect.
            User does not have local access to the files, so you must provide direct URLs for any external resources (e.g., images uploaded to cloud storage).
            When including downloadable assets, always look for and use the `download_url` provided in JSON outputs from the `file_cloud_uploader_agent`. These URLs are public and include necessary SAS tokens for access.
            Crucially, your output should be a final, polished presentation of the task result, suitable for direct display in a user interface.
            **Your report MUST only contain the direct result of the user's task. Absolutely NO explanations of how the task was accomplished, internal agent thought processes, or any operational details should be included. Do not mention which tools or agents were used, or how they were used to achieve the result.**
            **Focus exclusively on delivering the requested information (e.g., image galleries, reports) and only include minimal, essential explanations directly related to the visuals or content.** For example, for an image gallery, provide brief descriptions for each image or a short overview of the gallery structure, but do not explain the steps taken by the agents or the internal workflow.
            **Do not include extensive executive summaries, detailed operational breakdowns, or generic quick-start guides unless explicitly asked for.**
            Do not include raw code snippets, internal thought processes, intermediate data, or any technical logs that are not part of the final, user-friendly deliverable.
            **Absolutely DO NOT include instructions on how to run, save, or modify any code (e.g., "save as .py", "pip install", "python script.py").**
            **DO NOT provide information about packaging, dependencies, or development workflows.**
            Your output is for a non-technical end-user viewing it in a React app.
            **CRITICAL: ONLY use URLs for any files (images, videos, documents, etc.) that are explicitly provided in the `UPLOADED_FILES_SAS_URLS` or directly within the `RESULT` content from other agents, specifically from the `file_cloud_uploader_agent`. If a valid, real URL is not provided, you MUST NOT include any placeholder, fake, or fabricated URLs. NEVER hallucinate or fabricate any links or content.**
        """
    )

    file_cloud_uploader_agent = AssistantAgent(
        "file_cloud_uploader_agent",
        model_client=default_model_client,
        tools=[upload_file_to_cloud_tool],
        description="A helpful assistant that can upload files to the cloud.",
        system_message=f"""You are a helpful assistant that can upload files to the cloud.
            Upload referenced files to the cloud.
            Use your tool to upload the files.
            User does not have local access to the files so you must upload them to the cloud and provide the url.
            Your current working directory for file operations is: {work_dir}.
            When referencing local files for upload, **always prepend the '{work_dir}/' to the filename** to form the correct absolute path. For example, if a file is named 'test.text' in the working directory, the absolute path should be '{work_dir}/test.txt'.
        """,
    )
    
    agents = [coder_agent, code_executor_agent, file_cloud_uploader_agent, presenter_agent, terminator_agent]

    return agents, presenter_agent 