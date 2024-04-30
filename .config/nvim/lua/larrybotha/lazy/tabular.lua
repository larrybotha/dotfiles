-- see https://gist.github.com/tpope/287147?permalink_comment_id=3637398#gistcomment-3637398
local function tabularizePipes()
  local pattern = '^%s*|%s.*%s|%s*$'
  local currLine, currentColumn = fn.line('.') , fn.col('.')
  local prevLine, currLine, nextLine =
    fn.getline(currLine - 1)
    ,fn.getline('.')
    ,fn.getline(currLine + 1)
  local isTabular = currLine:match('^%s*|')
    and (prevLine:match(pattern) or nextLine:match(pattern))

  if fn.exists(':Tabularize') and isTabular then
    local column = #currLine:sub(1, currentColumn):gsub('[^|]', '')
    local position = #fn.matchstr(currLine:sub(1, currentColumn), ".*|\\s*\\zs.*")

    cmd('Tabularize/|/l1') -- I: left aligned, 1: one space of cell padding
    cmd('normal! 0')
    fn.search(
      ('[^|]*|'):rep(column) .. ('\\s\\{-\\}'):rep(position),
      'ce',
      currLine
    )
  end
end

return {
  'godlygeek/tabular',
  name = "tabular",
  init = function()
    -- align equal signs in normal and visual mode
    vim.keymap.set({"n", "v"}, "<Leader>a=", ":Tabularize /=<CR>")

    -- align colons in normal and visual mode
    vim.keymap.set({"n", "v"}, "<Leader>a:", ":Tabularize /:\zs<CR>")

    _G.DoTheTableAlign = tabularizePipes

    -- use Tabularize when in insert mode and a | is typed
    -- http://vimcasts.org/episodes/aligning-text-with-tabular-vim/
    vim.keymap.set("i", "<Bar>", "<Bar><Esc>:lua DoTheTableAlign()<CR>a", {silent=true})
  end
}
