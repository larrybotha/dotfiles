-- see https://gist.github.com/tpope/287147?permalink_comment_id=3637398#gistcomment-3637398
-- Align markdown table columns when typing | in insert mode.
--
-- Detects if cursor is inside a markdown table (current line starts with | and
-- adjacent lines match table pattern). Runs Tabularize to align all columns,
-- strips accidental leading whitespace that l1 padding adds, then restores
-- cursor to the | that was just typed.
--
-- @param none (uses cursor position)
-- @return nil (side effects: buffer modified, cursor moved)
local function tabularizePipes()
	local cmd, fn = vim.cmd, vim.fn
	local pattern = "^%s*|%s.*%s|%s*$"
	local lineNumber, currentColumn = fn.line("."), fn.col(".")
	local previousLine, currentLine, nextLine = fn.getline(lineNumber - 1), fn.getline("."), fn.getline(lineNumber + 1)

	if
		fn.exists(":Tabularize") == 2
		and currentLine:match("^%s*|")
		and (previousLine:match(pattern) or nextLine:match(pattern))
	then
		-- column = which | was typed (1-based), position = chars after that |
		local column = #currentLine:sub(0, currentColumn):gsub("[^|]", "")
		local position = #fn.matchstr(currentLine:sub(1, currentColumn), ".*|s*\zs.*")

		-- save cursor; Tabularize + g// moves cursor unpredictably
		local view = fn.winsaveview()
		cmd("Tabularize/|/l1") -- left-aligned, 1 space padding around delimiters
		cmd("keepjumps g/^\\s*|/s/^\\s*//") -- strip creeping leading indent
		fn.winrestview(view)

		-- move to start of line, then search for the exact | we typed
		cmd("normal! 0")
		fn.search(("[^|]*|"):rep(column) .. ("\\s\\{-\\}"):rep(position), "ce", lineNumber)
	end
end

return {
	"godlygeek/tabular",
	name = "tabular",
	init = function()
		_G.DoTheTableAlign = tabularizePipes

		-- use Tabularize when in insert mode and a | is typed
		-- http://vimcasts.org/episodes/aligning-text-with-tabular-vim/
		vim.keymap.set(
			"i",
			"<Bar>",
			"<Bar><Esc>:lua DoTheTableAlign()<CR>a",
			{ silent = true, desc = "Tabularize markdown table" }
		)
	end,
}
