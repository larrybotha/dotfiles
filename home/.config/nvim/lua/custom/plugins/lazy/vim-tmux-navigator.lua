-- Programs where C-[hjkl] should pass through to the terminal instead of navigating.
-- These programs handle C-[hjkl] themselves (e.g. lazygit uses C-j/C-k for commit list).
-- The match is against the buffer name, so the program name must appear in the
-- term:// buffer path (e.g. term:///path/lazygit matches "lazygit").
local passthrough_programs = { "lazygit" }

--- Navigate to the adjacent vim split or tmux pane.
--- In terminal mode: exits terminal mode first, then navigates.
--- For passthrough programs: sends the raw key to the terminal instead.
---@param key string Direction key (h/j/k/l)
---@param nav_cmd string Vim command (TmuxNavigateLeft etc.)
local function navigate_or_passthrough(key, nav_cmd)
	return function()
		local bufname = vim.api.nvim_buf_get_name(0)
		local is_passthrough = false

		for _, proc_name in ipairs(passthrough_programs) do
			if bufname:match(proc_name) then
				is_passthrough = true
				break
			end
		end

		if is_passthrough then
			-- Send raw key to the terminal program via its channel
			-- nvim_feedkeys doesn't reliably reach the terminal program from t-mode callbacks
			local chan = vim.bo.channel
			if chan and chan > 0 then
				-- Ctrl+letter = ASCII(letter) - 96 (e.g. C-h = 104-96 = 8)
				vim.api.nvim_chan_send(chan, string.char(string.byte(key) - 96))
			end
		else
			-- Exit terminal mode first so navigation lands in normal mode
			if vim.api.nvim_get_mode().mode == "t" then
				vim.cmd("stopinsert")
			end
			vim.cmd(nav_cmd)
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
			-- Prevent plugin from setting its own (conflicting) tnoremaps.
			-- Without this, the plugin's tnoremap uses <C-w>: which fails inside
			-- snacks.terminal — the command name gets typed as literal text.
			vim.g.tmux_navigator_no_mappings = 1

			vim.keymap.set({ "n", "t" }, "<C-h>", navigate_or_passthrough("h", "TmuxNavigateLeft"))
			vim.keymap.set({ "n", "t" }, "<C-j>", navigate_or_passthrough("j", "TmuxNavigateDown"))
			vim.keymap.set({ "n", "t" }, "<C-k>", navigate_or_passthrough("k", "TmuxNavigateUp"))
			vim.keymap.set({ "n", "t" }, "<C-l>", navigate_or_passthrough("l", "TmuxNavigateRight"))
			vim.keymap.set({ "n", "t" }, "<C-\\>", "<cmd>TmuxNavigatePrevious<cr>")
		end,
	},
}
