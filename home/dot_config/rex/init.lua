local T = "com.superlogical.terminal"

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
