local dap, dapui = require("dap"), require("dapui")
local dap_ui_widgets = require("dap.ui.widgets")

-- dap
vim.keymap.set("n", "<F5>", dap.continue)
vim.keymap.set("n", "<F8>", dap.continue)
vim.keymap.set("n", "<F10>", dap.step_over)
vim.keymap.set("n", "<F11>", dap.step_into)
vim.keymap.set("n", "<F12>", dap.step_out)
vim.keymap.set("n", "<Leader>db", dap.toggle_breakpoint)
vim.keymap.set("n", "<Leader>dB", dap.set_breakpoint)
vim.keymap.set("n", "<Leader>dlp", function()
	dap.set_breakpoint(nil, nil, vim.fn.input("Log point message: "))
end)
vim.keymap.set("n", "<Leader>dr", dap.repl.open)
vim.keymap.set("n", "<Leader>dl", dap.run_last)
vim.keymap.set({ "n", "v" }, "<Leader>dh", dap_ui_widgets.hover)
vim.keymap.set({ "n", "v" }, "<Leader>dp", dap_ui_widgets.preview)
vim.keymap.set("n", "<Leader>df", function()
	dap_ui_widgets.centered_float(dap_ui_widgets.frames)
end)
vim.keymap.set("n", "<Leader>ds", function()
	dap_ui_widgets.centered_float(dap_ui_widgets.scopes)
end)

local function get_python_binary()
	local cwd = vim.fn.getcwd()
	local virtual_env = os.getenv("VIRTUAL_ENV")

	if virtual_env then
		return virtual_env .. "/bin/python"
	elseif vim.fn.executable(cwd .. "/venv/bin/python") == 1 then
		return cwd .. "/venv/bin/python"
	else
		return os.getenv("HOME") .. "/.pyenv/shims/python"
	end
end

local python_settings = {
	adapter = {
		type = "executable",
		command = os.getenv("HOME") .. "/.pyenv/shims/python",
		args = { "-m", "debugpy.adapter" },
	},
	configs = {
		{
			type = "python",
			request = "launch",
			name = "Launch file",
			program = "${file}",
			pythonPath = get_python_binary,
		},
		{
			-- https://github.com/microsoft/debugpy/wiki/Debug-configuration-settings
			connect = {
				host = "localhost",
				port = 5678,
			},
			name = "Attach to Django",
			request = "attach",
			type = "python",
			django = true,
			python = get_python_binary(),
		},
	},
}

dap.adapters.python = python_settings.adapter
dap.configurations.python = python_settings.configs

-- dapui
dap.listeners.after.event_initialized["dapui_config"] = dapui.open
dap.listeners.before.event_terminated["dapui_config"] = dapui.close
dap.listeners.before.event_exited["dapui_config"] = dapui.close

dapui.setup()
