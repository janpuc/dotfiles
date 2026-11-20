local T = "com.superlogical.terminal"
local SHELL = T .. ".shell"

-- The agent platform this palette drives. The server's PATH has no ~/.local/bin.
local HOME = os.getenv("HOME")
local AGENT = HOME .. "/.local/bin/agent"
local FETCH = HOME .. "/.local/bin/agent-fetch"
local DEV = HOME .. "/Development"
local ATTENTION = HOME .. "/.local/state/agents/attention"
local unpack = table.unpack or unpack

rex.bind("ctrl+cmd+a", "client.sidebar.activity.toggle")
rex.bind("ctrl+cmd+f", "client.sidebar.filter.focus")
rex.bind("ctrl+cmd+g", "pane.go_to")
rex.bind("ctrl+cmd+v", "pane.view_activity")

rex.action{
  name = "go_project",
  title = "Go to Project",
  args = { name = "string" },
  run = function(ctx, args)
    local r, err = rex.call("target.resolve", { queries = { args.name }, kinds = { "session" } })
    if err ~= nil then error(err, 0) end
    local hit = (r.results or {})[1]
    if not hit or hit.status ~= "resolved" then error("no session named " .. args.name, 0) end
    rex.client.queue("session.select", { session_id = hit.target.session_id })
    return hit.target
  end,
}
rex.bind("ctrl+cmd+h", "go_project", { name = "home" })

rex.action{
  name = "next_waiting",
  title = "Go to Next Waiting Agent",
  run = function(ctx, args)
    local blocked, done = {}, {}
    for _, s in ipairs((rex.call("session.list") or {}).sessions or {}) do
      rex.session.attach{ session_id = s.session_id }
      local view = rex.session.view{ session_id = s.session_id }
      for _, w in ipairs((view and view.windows) or {}) do
        for _, layer in ipairs(w.layers or {}) do
          for _, b in ipairs(layer.blocks or {}) do
            if b.creator_name == T then
              local st = rex.block.call(T, "program_status",
                { session_id = s.session_id, block_id = b.block_id }) or {}
              for _, rec in ipairs(st.records or {}) do
                local t = { session_id = s.session_id, window_id = w.window_id }
                if rec.state == "blocked" then blocked[#blocked+1] = t
                elseif rec.state == "done" then done[#done+1] = t end
              end
            end
          end
        end
      end
    end
    local t = blocked[1] or done[1]
    if t == nil then return nil end
    rex.client.queue("session.select", t)
    return t
  end,
}
rex.bind("ctrl+cmd+n", "next_waiting")

-- Data from the agent platform, all of it read on the machine the agents run on.

local function trim(s)
  return (s:gsub("^%s+", ""):gsub("%s+$", ""))
end

-- Runs a command and returns its output, or nil and a one line reason.
local function run(argv, timeout)
  local r, err = rex.exec(argv, { timeout = timeout or 20 })
  if r == nil then return nil, argv[1] .. ": " .. err end
  if not r.ok then
    local why = trim(r.stderr)
    if why == "" then why = "exit status " .. r.code end
    return nil, table.concat(argv, " ") .. ": " .. why
  end
  return r.stdout
end

local function must(argv, timeout)
  local out, err = run(argv, timeout)
  if out == nil then error(err, 0) end
  return out
end

local function read_file(path)
  local f = io.open(path, "r")
  if f == nil then return nil end
  local text = f:read("*a")
  f:close()
  return text
end

-- A prompt returns nil and a reason. Cancelling is the only quiet way out.
local function asked(value, why)
  if value ~= nil then return value end
  if why ~= "cancelled" then error("prompt: " .. (why or "failed"), 0) end
  return nil
end

-- agent ls prints one line per project, then an indented line per workspace member.
local function active_projects()
  local list = {}
  for line in must({ AGENT, "ls" }):gmatch("[^\n]+") do
    if line:sub(1, 1) ~= " " then
      local name = line:match("^(%S+)")
      local rest = line:sub(#name + 1)
      if rest:find("lifecycle=", 1, true) and rest:match("lifecycle=(%S+)") == "active" then
        list[#list + 1] = {
          name = name,
          session = rest:match("rex=session:(%S+)"),
          pi = rest:match("pi=(%S+)"),
        }
      end
    end
  end
  return list
end

local function session_by_project(projects)
  local by_name = {}
  for _, p in ipairs(projects) do
    if p.session ~= nil then by_name[p.name] = "session:" .. p.session end
  end
  return by_name
end

local function tasks(statuses)
  local list = {}
  for line in must({ AGENT, "task", "ls" }):gmatch("[^\n]+") do
    local project, task, rest = line:match("^(%S+) (%S+) (.*)$")
    if project ~= nil then
      local status = rest:match("status=(%S+)")
      if statuses[status] then
        list[#list + 1] = {
          project = project,
          task = task,
          status = status,
          pi = rest:match("pi=(%S+)"),
        }
      end
    end
  end
  return list
end

local function is_waiting(project, task)
  local f = io.open(ATTENTION .. "/" .. project .. "--" .. task .. ".json", "r")
  if f == nil then return false end
  f:close()
  return true
end

local function task_model(project, task)
  local text = read_file(DEV .. "/" .. project .. "/.agent/tasks/" .. task .. "/model")
  if text == nil then return nil end
  text = trim(text)
  if text == "" then return nil end
  return text
end

local OPEN_TASKS = { open = true, closing = true }
local OPEN_ONLY = { open = true }

-- Waiting first, then closing, then running, then stopped.
local RANK = { waiting = 1, closing = 2, running = 3, stopped = 4 }

local function state_of(status, pi, waiting)
  if waiting then return "waiting" end
  if status == "closing" then return "closing" end
  if pi == "yes" then return "running" end
  return "stopped"
end

local function by_rank(a, b)
  if a.rank ~= b.rank then return a.rank < b.rank end
  if a.title ~= b.title then return a.title < b.title end
  return a.id < b.id
end

-- Every active project and every open or closing task, as pick items plus where each goes.
local function agent_picks()
  local projects = active_projects()
  local sessions = session_by_project(projects)
  local rows = {}
  for _, p in ipairs(projects) do
    local session = sessions[p.name]
    if session ~= nil then
      local state = state_of(nil, p.pi, false)
      local id = "project:" .. p.name
      rows[#rows + 1] = {
        rank = RANK[state],
        title = p.name,
        id = id,
        item = { id = id, title = p.name, subtitle = "project", icon = "folder", detail = state },
        target = { session = session },
      }
    end
  end
  for _, t in ipairs(tasks(OPEN_TASKS)) do
    local session = sessions[t.project]
    if session ~= nil then
      local state = state_of(t.status, t.pi, is_waiting(t.project, t.task))
      local id = "task:" .. t.project .. "/" .. t.task
      local model = task_model(t.project, t.task)
      local subtitle = t.project
      if model ~= nil then subtitle = subtitle .. " " .. model end
      rows[#rows + 1] = {
        rank = RANK[state],
        title = t.task,
        id = id,
        item = { id = id, title = t.task, subtitle = subtitle, icon = "terminal", detail = state },
        target = { session = session, window = "task:" .. t.task },
      }
    end
  end
  table.sort(rows, by_rank)
  local items, targets = {}, {}
  for _, row in ipairs(rows) do
    items[#items + 1] = row.item
    targets[row.id] = row.target
  end
  return items, targets
end

-- Selects the project session, and the task tab when one is named.
local function go_to(target)
  if target.window == nil then
    rex.client.queue("session.select", { session_id = target.session })
    return target
  end
  local r, err = rex.call("target.resolve", {
    kinds = { "window" },
    queries = { target.window },
    scope = { session = target.session },
  })
  if err ~= nil then error(err, 0) end
  local hit = (r.results or {})[1]
  local args = { session_id = target.session }
  if hit ~= nil and hit.status == "resolved" then args.window_id = hit.target.window_id end
  rex.client.queue("session.select", args)
  return args
end

rex.action{
  name = "agents_items",
  title = "Agents: List Projects and Tasks",
  run = function(ctx, args)
    local items = agent_picks()
    return items
  end,
}

rex.action{
  name = "pick_agent",
  title = "Agents: Go to Project or Task",
  run = function(ctx, args)
    local items, targets = agent_picks()
    if #items == 0 then error("no active projects", 0) end
    local id = asked(rex.ui.pick{
      title = "Go to project or task",
      placeholder = "Filter projects and tasks",
      items = items,
    })
    if id == nil then return nil end
    return go_to(targets[id])
  end,
}
rex.bind("ctrl+cmd+p", "pick_agent")

local MODELS = {
  { id = "claude-bridge/claude-opus-5-5", title = "Opus", subtitle = "default" },
  { id = "agy/gemini-4-neon:high", title = "Neon", subtitle = "long builds" },
  { id = "alibaba/deepseek-v4.1-flash:medium", title = "DeepSeek", subtitle = "cheap" },
}

rex.action{
  name = "new_task",
  title = "Agents: New Task",
  run = function(ctx, args)
    local names = {}
    for _, p in ipairs(active_projects()) do names[#names + 1] = p.name end
    if #names == 0 then error("no active projects", 0) end
    local project = asked(rex.ui.pick{
      title = "New task: project",
      placeholder = "Filter projects",
      items = names,
    })
    if project == nil then return nil end

    local slug, title = nil, "New task in " .. project .. ": slug"
    while slug == nil do
      local text = asked(rex.ui.input{
        title = title,
        placeholder = "kebab-case id",
        confirm = "Use slug",
      })
      if text == nil then return nil end
      text = trim(text)
      if text:match("^[a-z0-9][a-z0-9%-]{1,39}$") then
        slug = text
      else
        title = "Slug needs 2 to 40 of a-z, 0-9 and dashes: try again"
      end
    end

    local model = asked(rex.ui.pick{
      title = "New task " .. project .. "/" .. slug .. ": model",
      items = MODELS,
    })
    if model == nil then return nil end

    local brief = asked(rex.ui.input{
      title = "New task " .. project .. "/" .. slug .. ": brief",
      placeholder = "What should the agent do",
      confirm = "Open task",
    })
    if brief == nil then return nil end
    brief = trim(brief)
    if brief == "" then error("a task needs a brief", 0) end

    local out = must({ AGENT, "task", "new", project, "--model", model, "--slug", slug, brief }, 25)
    return { project = project, task = slug, model = model, output = out }
  end,
}
-- ctrl+cmd+t is free in Rex's own defaults, so the new task shortcut takes it.
rex.bind("ctrl+cmd+t", "new_task")

local function task_targets(statuses)
  local sessions = session_by_project(active_projects())
  local items, targets = {}, {}
  for _, t in ipairs(tasks(statuses)) do
    local session = sessions[t.project]
    if session ~= nil then
      local state = state_of(t.status, t.pi, is_waiting(t.project, t.task))
      local model = task_model(t.project, t.task)
      local subtitle = t.project
      if model ~= nil then subtitle = subtitle .. " " .. model end
      items[#items + 1] = {
        id = t.project .. "/" .. t.task,
        title = t.task,
        subtitle = subtitle,
        icon = "terminal",
        detail = state,
      }
      targets[t.project .. "/" .. t.task] = { project = t.project, task = t.task, session = session }
    end
  end
  return items, targets
end

rex.action{
  name = "task_action",
  title = "Agents: Message or Close Task",
  run = function(ctx, args)
    local items, targets = task_targets(OPEN_ONLY)
    if #items == 0 then error("no open tasks", 0) end
    local id = asked(rex.ui.pick{
      title = "Task",
      placeholder = "Filter open tasks",
      items = items,
    })
    if id == nil then return nil end
    local t = targets[id]
    local choice = asked(rex.ui.pick{
      title = t.project .. "/" .. t.task,
      items = {
        { id = "send", title = "Send message", icon = "terminal" },
        { id = "close", title = "Close task", icon = "document" },
      },
    })
    if choice == nil then return nil end

    if choice == "send" then
      local text = asked(rex.ui.input{
        title = "Message " .. t.project .. "/" .. t.task,
        placeholder = "What to tell the task",
        confirm = "Send",
      })
      if text == nil then return nil end
      text = trim(text)
      if text == "" then error("the message is empty", 0) end
      local out = must({ AGENT, "task", "send", t.project, t.task, text }, 25)
      return { project = t.project, task = t.task, sent = text, output = out }
    end

    local out = must({ AGENT, "task", "close", t.project, t.task }, 25)
    return { project = t.project, task = t.task, closed = true, output = out }
  end,
}

rex.action{
  name = "close_tasks",
  title = "Agents: Close Tasks",
  run = function(ctx, args)
    local items, targets = task_targets(OPEN_ONLY)
    if #items == 0 then error("no open tasks", 0) end
    local ids = asked(rex.ui.pick{
      title = "Close tasks",
      placeholder = "Filter open tasks",
      multiple = true,
      confirm = "Close",
      items = items,
    })
    if ids == nil or #ids == 0 then return nil end
    local closed, failed = {}, {}
    for _, id in ipairs(ids) do
      local t = targets[id]
      local out, err = run({ AGENT, "task", "close", t.project, t.task }, 20)
      if out == nil then
        failed[#failed + 1] = t.project .. "/" .. t.task .. ": " .. err
      else
        closed[#closed + 1] = t.project .. "/" .. t.task
      end
    end
    if #failed > 0 then error(table.concat(failed, ". "), 0) end
    return { closed = closed }
  end,
}

rex.action{
  name = "pick_todo",
  title = "Agents: Pending Approvals",
  run = function(ctx, args)
    local sessions = session_by_project(active_projects())
    local items, targets = {}, {}
    local n = 0
    for line in must({ AGENT, "todo" }):gmatch("[^\n]+") do
      local project, text = line:match("^(%S+): (%S.*)$")
      local session = project and sessions[project]
      if session ~= nil then
        n = n + 1
        items[#items + 1] = {
          id = project .. "#" .. n,
          title = text,
          subtitle = project,
          icon = "clock",
        }
        targets[project .. "#" .. n] = { session = session }
      end
    end
    if #items == 0 then return { pending = 0 } end
    local id = asked(rex.ui.pick{
      title = "Pending approvals",
      placeholder = "Filter approvals",
      items = items,
    })
    if id == nil then return nil end
    return go_to(targets[id])
  end,
}

-- Files changed in the last week, newest first, under the folders worth fetching:
-- the project's own tasks and notes, and any artifacts or out folder below it.
local function recent_files(project)
  local root = DEV .. "/" .. project
  local r = rex.exec({
    "find", root,
    "(", "-name", ".git", "-o", "-name", "node_modules", "-o", "-name", ".worktrees", ")", "-prune",
    "-o", "-type", "f", "-mtime", "-7", "-size", "-200M",
    "(", "-path", root .. "/tasks/*", "-o", "-path", root .. "/notes/*",
    "-o", "-path", "*/artifacts/*", "-o", "-path", "*/out/*", ")",
    "-printf", "%T@\t%p\n",
  }, { timeout = 25 })
  if r == nil or r.stdout == nil then return {} end
  local files = {}
  for line in r.stdout:gmatch("[^\n]+") do
    local stamp, path = line:match("^(%S+)\t(.+)$")
    if path ~= nil then
      files[#files + 1] = { mtime = tonumber(stamp), path = path, rel = path:sub(#DEV + 2) }
    end
  end
  table.sort(files, function(a, b)
    if a.mtime ~= b.mtime then return a.mtime > b.mtime end
    return a.path < b.path
  end)
  local capped = {}
  for i = 1, math.min(#files, 2000) do capped[i] = files[i] end
  return capped
end

local function quote(s)
  return "'" .. s:gsub("'", "'\\''") .. "'"
end

-- A terminal that shows the URLs and stays, so they can be clicked or Quick Looked.
local function fetch_command(output)
  local lines = {}
  for line in output:gmatch("[^\n]+") do
    lines[#lines + 1] = quote(line)
  end
  if #lines == 0 then error("agent-fetch printed no URLs", 0) end
  return { "bash", "-c", "printf '%s\\n' " .. table.concat(lines, " ") .. " && sleep 3600" }
end

local function fetch_window(output)
  local w, err = rex.session.new_window{
    layout = rex.layout.block{
      flavor = SHELL,
      options = {
        shell = "none",
        command = fetch_command(output),
        exit = { on_completion = false },
      },
    },
  }
  if err ~= nil then error(err, 0) end
  rex.session.set_window_label{ window_id = w.window_id, label = "fetch" }
  return w
end

rex.action{
  name = "fetch_files",
  title = "Agents: Fetch Files to Mac",
  run = function(ctx, args)
    local names = {}
    for _, p in ipairs(active_projects()) do names[#names + 1] = p.name end
    if #names == 0 then error("no active projects", 0) end
    local project = asked(rex.ui.pick{
      title = "Fetch files: project",
      placeholder = "Filter projects",
      items = names,
    })
    if project == nil then return nil end

    local items = {}
    for _, f in ipairs(recent_files(project)) do
      items[#items + 1] = {
        id = f.path,
        title = f.path:match("[^/]+$"),
        subtitle = f.rel,
        icon = "document",
        detail = os.date("%Y-%m-%d %H:%M", f.mtime),
      }
    end
    if #items == 0 then error("nothing changed in " .. project .. " in the last 7 days", 0) end

    local chosen = asked(rex.ui.pick{
      title = "Fetch from " .. project,
      placeholder = "Filter files",
      multiple = true,
      confirm = "Serve",
      items = items,
    })
    if chosen == nil or #chosen == 0 then return nil end

    local out = must({ FETCH, unpack(chosen) }, 25)
    local w = fetch_window(out)
    return { files = #chosen, window_id = w.window_id, output = out }
  end,
}