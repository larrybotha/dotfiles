-- See: https://github.com/christoomey/vim-tmux-navigator/issues/295#issuecomment-1123455337
local function setIsVim(is_vim)
	local command = "silent !tmux set-option -p @custom_is_vim"

	if is_vim then
		command = command .. " yes"
	end

	vim.api.nvim_exec2(command, { output = true })
end

local CustomVimTmuxNavigatorGroup = vim.api.nvim_create_augroup("CustomVimTmuxNavigatorGroup", {})

return {
	{
		"christoomey/vim-tmux-navigator",
		name = "vim-tmux-navigator",
		config = function()
			vim.api.nvim_create_autocmd({ "VimEnter", "VimResume" }, {
				callback = function()
					setIsVim(true)
				end,
				desc = "set an option in tmux indicating that we're in vim",
				group = CustomVimTmuxNavigatorGroup,
				pattern = "*",
			})

			vim.api.nvim_create_autocmd({ "VimLeave", "VimSuspend" }, {
				callback = function()
					setIsVim(false)
				end,
				desc = "set an option in tmux indicating that we're not in vim",
				group = CustomVimTmuxNavigatorGroup,
				pattern = "*",
			})
		end,
	},
}
