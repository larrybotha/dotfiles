-- Function to create a virtual environment and install debugpy
local function create_virtualenv_and_install_debugpy()
	vim.fn.mkdir("$HOME/.virtualenvs", "p")
	--vim.fn.chdir("$HOME/.virtualenvs")
	vim.fn.system("$(cd $HOME/.virtualenvs && python -m venv debugpy)")
	--vim.fn.chdir("debugpy")
	vim.fn.system("$HOME/.virtualenvs/debugpy/ && python -m pip install debugpy)")
	--vim.fn.chdir(vim.fn.getcwd())
end

local configurePython = function()
	--local uv = vim.uv or vim.loop
	--local debugpyPath = "$HOME/.virtualenvs/debugpy/bin/python"

	--if not uv.fs_stat(debugpyPath) then
	--  create_virtualenv_and_install_debugpy()
	--end

	--local masonRegistry = require("mason-registry")

	--if not masonRegistry.has_package("debugpy") then
	--  return
	--end

	--if not masonRegistry.is_installed("debugpy") then
	--  return
	--end

	--local debugpyPackage = masonRegistry.get_package("debugpy")
	--local debugpyPath = debugpyPackage:get_install_path()

	--require("dap-python").setup(debugpyPath)

	-- TODO: automate this:
	--  mkdir ~/.virtualenvs
	--  cd ~/.virtualenvs
	--  python -m venv debugpy
	--  debugpy/bin/python -m pip install debugpy
	require("dap-python").setup("~/.virtualenvs/debugpy/bin/python")
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

return {
	"rcarriga/nvim-dap-ui",
	dependencies = {
		"mfussenegger/nvim-dap",
		"mfussenegger/nvim-dap-python",
		"nvim-neotest/nvim-nio",
		"williamboman/mason.nvim",
	},
	config = function()
		configureKeymaps()
		configureUi()
		configurePython()
	end,
}
