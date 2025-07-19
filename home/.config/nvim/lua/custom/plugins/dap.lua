local function ensureDebugpyInstalled(envDir)
	local envName = "debugpy-nvim-dap"
	local debugpyPath = envDir .. "/" .. envName
	local envPython = envName .. "/bin/python"

	vim.fn.mkdir(envDir, "p")

	if not vim.uv.fs_stat(debugpyPath) then
		vim.print("creating virtualenv...")
		vim.system({ "python", "-m", "venv", envName }, {
			cwd = envDir,
			text = true,
		}):wait()

		vim.print("installing debugpy...")

		vim.system({ envPython, "-m", "pip", "install", "debugpy" }, {
			cwd = envDir,
			text = true,
		}):wait()

		vim.print("debugpy installed!")
	end

	return envDir .. "/" .. envPython
end

local dap, dapui = require("dap"), require("dapui")
local setKeymap = vim.keymap.set

dapui.setup()

setKeymap("n", "<F5>", dap.continue, { desc = "DAP continue" })
setKeymap("n", "<leader>dc", dap.continue, { desc = "DAP continue" })
setKeymap("n", "<leader>dso", dap.step_over, { desc = "DAP step over" })
setKeymap("n", "<F11>", dap.step_into, { desc = "DAP step into" })
setKeymap("n", "<leader>dsi", dap.step_into, { desc = "DAP step into" })
setKeymap("n", "<S-F11>", dap.step_out, { desc = "DAP step out" })
setKeymap("n", "<leader>dsO", dap.step_out, { desc = "DAP step out" })
setKeymap("n", "<leader>db", dap.toggle_breakpoint, { desc = "DAP toggle breakpoint" })
setKeymap("n", "<leader>dB", dap.set_breakpoint, { desc = "DAP set breakpoint" })
setKeymap("n", "<leader>dlp", function()
	dap.set_breakpoint(nil, nil, vim.fn.input("Log point message: "))
end, { desc = "DAP set breakpoint with log message" })
setKeymap("n", "<leader>dl", dap.run_last, { desc = "DAP run last" })
setKeymap("n", "<leader>dk", dapui.eval, { desc = "DAP eval" })

-- open and close ui
dap.listeners.before.attach.dapui_config = dapui.open
dap.listeners.before.launch.dapui_config = dapui.open
dap.listeners.before.event_terminated.dapui_config = dapui.close
dap.listeners.before.event_exited.dapui_config = dapui.close

require("dap-go").setup()

local debugpyPython = ensureDebugpyInstalled(vim.fn.expand("$HOME/.local/share/virtualenvs"))

require("dap-python").setup(debugpyPython)

table.insert(require("dap").configurations.python, {
	type = "python",
	request = "launch",
	name = "Django",
	program = vim.fn.getcwd() .. "/src/manage.py",
	args = { "runserver", "--noreload" },
})
