local augroup = vim.api.nvim_create_augroup
local SuperCoolGroup = augroup("SuperCoolGroup", {})

function DoTheColours()
	-- Define custom cursor colors highlights
	opts = {bold=true, bg="black"}
	vim.api.nvim_set_hl(0, "CursorLine", opts)
	vim.api.nvim_set_hl(0, "CursorColumn", opts)

	-- Highlight trailing white space
	vim.api.nvim_set_hl(0, "ExtraWhiteSpace", {bg="red"})
 	vim.cmd([[match ExtraWhitespace /\s\+$/]]) 
end

vim.api.nvim_create_autocmd("ColorScheme", {
	group = SuperCoolGroup,
	pattern = "*",
	callback = DoTheColours
})


