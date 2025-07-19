local function set_highlights()
	local win_sep_hl = vim.api.nvim_get_hl(0, { name = "WinSeparator" })
	local more_msg_hl = vim.api.nvim_get_hl(0, { name = "MoreMsg" })
	local highlights = {
		["CursorColumn"] = { bold = false, bg = nil },
		["CursorLine"] = { bold = true, bg = win_sep_hl.fg },
		["ExtraWhiteSpace"] = { bg = more_msg_hl.fg },
	}

	for group, opts in pairs(highlights) do
		vim.api.nvim_set_hl(0, group, opts)
	end
end

vim.cmd([[match ExtraWhitespace /\s\+$/]])

vim.api.nvim_create_user_command("DoTheColors", set_highlights, {})

set_highlights()
