local function ensureDebugpyInstalled()
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
setKeymap("n", "<leader>dj", dap.step_over, { desc = "DAP step over" })
setKeymap("n", "<leader>dl", dap.step_into, { desc = "DAP step into" })
setKeymap("n", "<leader>dk", dap.step_out, { desc = "DAP step out" })
setKeymap("n", "<leader>db", dap.toggle_breakpoint, { desc = "DAP toggle breakpoint" })
setKeymap("n", "<leader>dm", function()
	dap.set_breakpoint(nil, nil, vim.fn.input("Log point message: "))
end, { desc = "DAP set breakpoint with log message" })
setKeymap("n", "<leader>dL", dap.run_last, { desc = "DAP run last" })
setKeymap("n", "<leader>de", dapui.eval, { desc = "DAP eval" })

-- open and close ui
dap.listeners.before.attach.dapui_config = dapui.open
dap.listeners.before.launch.dapui_config = dapui.open
dap.listeners.before.event_terminated.dapui_config = dapui.close
dap.listeners.before.event_exited.dapui_config = dapui.close

require("dap-go").setup()

require("dap-python").setup(ensureDebugpyInstalled())

table.insert(require("dap").configurations.python, {
	type = "python",
	request = "launch",
	name = "Django",
	program = vim.fn.getcwd() .. "/src/manage.py",
	args = { "runserver", "--noreload" },
})
