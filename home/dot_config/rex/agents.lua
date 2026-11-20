-- Agent platform actions for the Mac. A Rex app's palette lists only its own server's actions,
-- so each stub here asks aether to run the action of the same name in aether's init.lua.
-- Its pickers still show here, since rex do on aether asks every connected app.
-- Errors land in ~/Library/Logs/rex-agents.log.
local REX = "/usr/bin/rex"
local CLIENT = "Hermes"

local function on_aether(name, args)
  local remote = { REX, "do", "-C", CLIENT, name }
  for k, v in pairs(args or {}) do remote[#remote + 1] = k .. "=" .. v end
  -- Detached, because a picker can wait longer than an action may run.
  local h, err = rex.exec.start({
    "/bin/sh", "-c",
    'ssh -o BatchMode=yes aether "$@" >>"$HOME/Library/Logs/rex-agents.log" 2>&1',
    "sh", table.concat(remote, " "),
  }, { detach = true })
  if h == nil then error("ssh aether: " .. tostring(err), 0) end
end

local function stub(name, title, binding, args)
  rex.action{
    name = name,
    title = title,
    category = "Agents",
    run = function() on_aether(name, args) end,
  }
  if binding ~= nil then rex.bind(binding, name) end
end

rex.action{
  name = "go_project",
  title = "Agents: Go to Project",
  category = "Agents",
  args = { name = "string" },
  run = function(ctx, args) on_aether("go_project", { name = args.name }) end,
}
rex.bind("ctrl+cmd+h", "go_project", { name = "home" })

stub("next_waiting", "Agents: Go to Next Waiting Agent", "ctrl+cmd+n")
stub("pick_agent", "Agents: Go to Project or Task", "ctrl+cmd+p")
stub("new_task", "Agents: New Task", "ctrl+cmd+t")
stub("task_action", "Agents: Message or Close Task")
stub("close_tasks", "Agents: Close Tasks")
stub("pick_todo", "Agents: Pending Approvals")
stub("fetch_files", "Agents: Fetch Files to Mac")
