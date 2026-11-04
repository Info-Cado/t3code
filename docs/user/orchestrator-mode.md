# Orchestrator mode

Turn on **Settings → Labs → Orchestrator mode** on web and desktop to run each project through one
agent. You tell the orchestrator what you want. It plans, writes a brief for each task, and hands the
work to agents.

The sidebar lists projects and says what each one needs: **Needs you**, **Failed**, **Working** or
**Done**. Projects that need you come first. Click a project to open its orchestrator.

## What the orchestrator can do

It reads the project, starts agents, and reports to you. It can't change files itself, on Claude and
Codex, because a read-only sandbox blocks it. On other providers only its instructions stop it, and
the agents panel says so.

Agents do all the work, including reviews. Each one is a normal thread that you can open from the
agents panel.

## Stepping in

Write to any agent at any time. Its thread says who wrote each message. The orchestrator hears what
you wrote at its next turn, and your message to a finished agent doesn't wake it.

**Stop** on the orchestrator ends its current turn. Its agents go on and still report back. **Stop
all** in the agents panel stops them too.

## Threads of your own

Press **+** under **Yours** in the agents panel, or the pen on a project row, to start a thread the
orchestrator doesn't run. It can read that thread if you ask, and it can't write to it.

## Starting over

Archive the orchestrator to start the next one with a clean slate. Its agents stay where they are.

Turn the setting off to get the thread list back. Nothing is deleted: orchestrators show as ordinary
threads, with their agents under them.
