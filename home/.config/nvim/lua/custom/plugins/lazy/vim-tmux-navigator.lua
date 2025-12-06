-- Set up keymaps with process detection
local function navigate_or_passthrough(key, nav_cmd)
	return function()
		-- lazygit: pass-through so that we can use <C-k> and <C-j> to move commits
		local processes = { "lazygit" }
		local bufname = vim.api.nvim_buf_get_name(0)

		for _, proc_name in ipairs(processes) do
			if bufname:match(proc_name) then
				vim.api.nvim_feedkeys(vim.keycode("<C-" .. key .. ">"), "n", false)
				break
			else
				vim.cmd(nav_cmd)
			end
		end
	end
end

return {
	{
		"christoomey/vim-tmux-navigator",
		cmd = {
			"TmuxNavigateLeft",
			"TmuxNavigateDown",
			"TmuxNavigateUp",
			"TmuxNavigateRight",
			"TmuxNavigatePrevious",
			"TmuxNavigatorProcessList",
		},
		init = function()
			local function set_keymaps()
				vim.keymap.set({ "n", "t" }, "<C-h>", navigate_or_passthrough("h", "TmuxNavigateLeft"))
				vim.keymap.set({ "n", "t" }, "<C-j>", navigate_or_passthrough("j", "TmuxNavigateDown"))
				vim.keymap.set({ "n", "t" }, "<C-k>", navigate_or_passthrough("k", "TmuxNavigateUp"))
				vim.keymap.set({ "n", "t" }, "<C-l>", navigate_or_passthrough("l", "TmuxNavigateRight"))
				vim.keymap.set({ "n", "t" }, "<C-\\>", "<cmd>TmuxNavigatePrevious<cr>")
			end

			set_keymaps()
		end,
	},
}
