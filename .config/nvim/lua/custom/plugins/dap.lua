local M = {}

-- create a virtual environment and install debugpy
local function create_virtualenv_and_install_debugpy()
	vim.fn.mkdir("$HOME/.virtualenvs", "p")
	--vim.fn.chdir("$HOME/.virtualenvs")
	vim.fn.system("$(cd $HOME/.virtualenvs && python -m venv debugpy)")
	--vim.fn.chdir("debugpy")
	vim.fn.system("$HOME/.virtualenvs/debugpy/ && python -m pip install debugpy)")
	--vim.fn.chdir(vim.fn.getcwd())
end

local configurePython = function()
	-- TODO: automate this installation
	require("dap-python").setup("~/.virtualenvs/debugpy/bin/python")

	table.insert(require("dap").configurations.python, {
		type = "python",
		request = "launch",
		name = "Django",
		program = vim.fn.getcwd() .. "/src/manage.py",
		args = { "runserver", "--noreload" },
	})
end

local configureKeymaps = function()
	local dap = require("dap")

	vim.keymap.set("n", "<F5>", function()
		dap.continue()
	end)
	vim.keymap.set("n", "<leader>dc", function()
		dap.continue()
	end)
	vim.keymap.set("n", "<leader>dso", function()
		dap.step_over()
	end)
	vim.keymap.set("n", "<F11>", function()
		dap.step_into()
	end)
	vim.keymap.set("n", "<leader>dsi", function()
		dap.step_into()
	end)
	vim.keymap.set("n", "<S-F11>", function()
		dap.step_out()
	end)
	vim.keymap.set("n", "<leader>dsO", function()
		dap.step_out()
	end)
	vim.keymap.set("n", "<leader>db", function()
		dap.toggle_breakpoint()
	end)
	vim.keymap.set("n", "<leader>dB", function()
		dap.set_breakpoint()
	end)
	vim.keymap.set("n", "<leader>dlp", function()
		dap.set_breakpoint(nil, nil, vim.fn.input("Log point message: "))
	end)
	vim.keymap.set("n", "<leader>dl", function()
		dap.run_last()
	end)
end

local configureUi = function()
	local dap, dapui = require("dap"), require("dapui")

	dapui.setup()

	vim.keymap.set("n", "<leader>dk", function()
		dapui.eval()
	end)

	dap.listeners.before.attach.dapui_config = function()
		dapui.open()
	end
	dap.listeners.before.launch.dapui_config = function()
		dapui.open()
	end
	dap.listeners.before.event_terminated.dapui_config = function()
		dapui.close()
	end
	dap.listeners.before.event_exited.dapui_config = function()
		dapui.close()
	end
end

M.setup = function()
	configureKeymaps()
	configureUi()
	require("dap-go").setup()
	configurePython()
end

return M
