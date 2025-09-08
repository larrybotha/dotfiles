local function getDapPythonPath()
	-- see https://github.com/mfussenegger/nvim-dap-python#usage
	-- for why we return 'uv' here
	if vim.fn.executable("uv") then
		if vim.fn.executable("uv run debugy --version") then
			return "uv"
		else
			vim.print("uv installed, but debugpy not installed")
		end
	elseif vim.fn.executable("debugpy-adapter") then
		return "debugpy-adapter"
	end

	vim.print("debugpy not installed")

	return "python3"
end

local dap, dapui = require("dap"), require("dapui")
local setKeymap = vim.keymap.set

dapui.setup()

setKeymap("n", "<leader>dc", dap.continue, { desc = "DAP continue" })
setKeymap("n", "<leader>dd", dap.disconnect, { desc = "DAP disconnect" })
setKeymap("n", "<leader>dh", dap.restart_frame, { desc = "DAP restart frame" })
setKeymap("n", "<leader>dj", dap.step_over, { desc = "DAP step over" })
setKeymap("n", "<leader>dk", dap.step_out, { desc = "DAP step out" })
setKeymap("n", "<leader>dl", dap.step_into, { desc = "DAP step into" })
setKeymap("n", "<leader>db", dap.toggle_breakpoint, { desc = "DAP toggle breakpoint" })
setKeymap("n", "<leader>dr", dap.run_to_cursor, { desc = "DAP run to cursor" })
setKeymap("n", "<leader>di", function()
	dap.set_breakpoint(vim.fn.input("Condition: "))
end, { desc = "DAP set breakpoint a condition" })
setKeymap("n", "<leader>dm", function()
	dap.set_breakpoint(nil, nil, vim.fn.input("Log point message: "))
end, { desc = "DAP set breakpoint with log message" })
setKeymap("n", "<leader>dL", dap.run_last, { desc = "DAP run last" })

setKeymap("n", "<leader>de", dapui.eval, { desc = "DAP eval" })
setKeymap("n", "<leader>dt", dapui.toggle, { desc = "DAP UI toggle" })

-- open and close ui
dap.listeners.before.attach.dapui_config = dapui.open
dap.listeners.before.launch.dapui_config = dapui.open
dap.listeners.before.event_terminated.dapui_config = dapui.close
dap.listeners.before.event_exited.dapui_config = dapui.close

vim.fn.sign_define("DapBreakpoint", { text = "●", texthl = "Constant", linehl = "", numhl = "" })
vim.fn.sign_define("DapBreakpointCondition", { text = "●", texthl = "Conditional", linehl = "", numhl = "" })
vim.fn.sign_define("DapLogPoint", { text = "●", texthl = "Changed", linehl = "", numhl = "" })
vim.fn.sign_define("DapStopped", { text = "»", texthl = "Added", linehl = "", numhl = "" })
vim.fn.sign_define("DapBreakpointRejected", { text = "✗", texthl = "Error", linehl = "", numhl = "" })

require("dap-go").setup()

-- setup dap-python
require("dap-python").setup(getDapPythonPath())

table.insert(dap.configurations.python, {
	name = "Django attach",
	django = "true", -- allows for debugging templates
	type = "python",
	-- requires starting django with debugpy
	request = "attach",
	connect = function()
		local host = vim.fn.input("Host [127.0.0.1]: ")
		host = host ~= "" and host or "127.0.0.1"
		local port = tonumber(vim.fn.input("Port [5678]: ")) or 5678
		return { host = host, port = port }
	end,
})

require("nvim-dap-virtual-text").setup()
