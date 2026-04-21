local create_autocmd = vim.api.nvim_create_autocmd
local SuperCoolGroup = vim.api.nvim_create_augroup("SuperCoolGroup", {})

---
-- Grepping
---
local function grepWithRipGrep(event, opts)
	if not vim.fn.executable("rg") then
		return
	end

	vim.opt.grepprg = "rg --vimgrep --hidden --smart-case"
	-- `%f` represents the file name where the match was found
	-- `%l` represents the line number where the match was found
	-- `%c` represents the column number where the match was found
	-- `%m` represents the matched text itself
	vim.opt.grepformat = "%f:%l:%c:%m"

	create_autocmd("QuickFixCmdPost", {
		command = "cwindow",
		desc = "open quickfix after grepping",
		group = SuperCoolGroup,
		nested = true,
		pattern = { "[^l]*" },
	})
	create_autocmd("QuickFixCmdPost", {
		command = "lwindow",
		desc = "open locationlist after grepping",
		group = SuperCoolGroup,
		nested = true,
		pattern = { "l*" },
	})
	--create_autocmd("QuickFixCmdPost",{
	--  command = "redraw",
	--  desc = [[
	--    force a redraw when quickfix list is updated to automatically close
	--    the 'Press Enter' prompt
	--  ]],
	--  group = SuperCoolGroup,
	--  pattern = { "[^l]*", "l*" }
	--})
end

create_autocmd("VimEnter", {
	callback = grepWithRipGrep,
	group = SuperCoolGroup,
	once = true,
	pattern = "*",
	desc = "use ripgrep as the grep program",
})

---
-- Auto-reloading files
---
local function syncExternalFileUpdates(event, opts)
	vim.opt.autoread = true -- update files in Vim that were updated externally

	create_autocmd({ "FocusGained", "BufEnter" }, {
		command = "silent! checktime",
		desc = "Evaluate the current file for external file changes when the cursor stop moving",
		group = SuperCoolGroup,
		pattern = "*",
	})

	-- https://vi.stackexchange.com/questions/14315/how-can-i-tell-if-im-in-the-command-window
	create_autocmd({ "FocusGained", "BufEnter" }, {
		command = "if mode() == 'n' && getcmdwintype() == '' | checktime | endif",
		desc = "Evaluate the current file for external file changes when the cursor stop moving",
		group = SuperCoolGroup,
		pattern = "*",
	})
end

create_autocmd("VimEnter", {
	callback = syncExternalFileUpdates,
	desc = "automatically update files in Neovim that are updated externally",
	group = SuperCoolGroup,
	once = true,
	pattern = "*",
})

---
-- Delete trailing whitespace on save
---
create_autocmd("BufWritePre", {
	command = "%s/\\s\\+$//e",
	desc = "delete trailing whitespace on save",
	group = SuperCoolGroup,
	pattern = "*",
})

-- Jump to the last known cursor position when opening a file.
--
-- Uses BufWinEnter instead of the canonical BufRead + nested FileType pattern
-- (:help last-position-jump) because in Neovim the FileType event fires before
-- the BufRead callback can register a nested FileType autocmd, so the nested
-- approach is unreliable.
--
-- BufWinEnter fires after the buffer is displayed in a window and after
-- filetype detection, so the " mark (restored from shada) and &ft are both
-- available.
create_autocmd("BufWinEnter", {
	callback = function(args)
		local ft = vim.bo[args.buf].filetype

		-- skip commit/rebase buffers (git messages shouldn't jump to previous position).
		if ft:match("commit") or ft:match("rebase") then
			return
		end

		local mark_line = vim.fn.line("'\"")
		local last_line = vim.api.nvim_buf_line_count(args.buf)

		-- skip if mark is on line 1 (the default; no point jumping there).
		-- skip if mark exceeds the file's line count (file was truncated since last visit).
		if mark_line > 1 and mark_line <= last_line then
			vim.cmd([[normal! g`"]])
		end
	end,
	desc = "jump to last known cursor position after reading file into buffer",
	group = SuperCoolGroup,
	pattern = "*",
})

---
-- Use hybrid line numbers when not in insert mode
---
local function setRelativeNumbers(value)
	if vim.opt.number:get() then
		vim.opt.relativenumber = value
	end
end

create_autocmd({ "BufEnter", "FocusGained", "InsertLeave", "WinEnter" }, {
	callback = function()
		setRelativeNumbers(true)
	end,
	desc = "enable relative numbers when not in insert mode",
	group = SuperCoolGroup,
	pattern = "*",
})

create_autocmd({ "BufLeave", "FocusLost", "InsertEnter", "WinLeave" }, {
	callback = function()
		setRelativeNumbers(false)
	end,
	desc = "don't use relative number when in insert mode",
	group = SuperCoolGroup,
	pattern = "*",
})
