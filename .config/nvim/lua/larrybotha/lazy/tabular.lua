-- see https://gist.github.com/tpope/287147?permalink_comment_id=3637398#gistcomment-3637398
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
		local column = #currentLine:sub(0, currentColumn):gsub("[^|]", "")
		local position = #fn.matchstr(currentLine:sub(1, currentColumn), ".*|\\s*\\zs.*")

		cmd("Tabularize/|/l1") -- I: left aligned, 1: one space of cell padding
		cmd("normal! 0")
		fn.search(("[^|]*|"):rep(column) .. ("\\s\\{-\\}"):rep(position), "ce", lineNumber)
	end
end

return {
	"godlygeek/tabular",
	name = "tabular",
	init = function()
		-- align equal signs in normal and visual mode
		vim.keymap.set({ "n", "v" }, "<Leader>a=", ":Tabularize /=<CR>")

		-- align colons in normal and visual mode
		vim.keymap.set({ "n", "v" }, "<Leader>a:", ":Tabularize /:\zs<CR>")

		_G.DoTheTableAlign = tabularizePipes

		-- use Tabularize when in insert mode and a | is typed
		-- http://vimcasts.org/episodes/aligning-text-with-tabular-vim/
		vim.keymap.set("i", "<Bar>", "<Bar><Esc>:lua DoTheTableAlign()<CR>a", { silent = true })
	end,
}
