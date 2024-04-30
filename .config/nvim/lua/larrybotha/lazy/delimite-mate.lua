return {
  'Raimondi/delimitMate',
  name ="delimit-mate",
  init = function()
    -- expand a new line after a brace to autoindent
    vim.g.delimitMate_expand_cr = 1

    -- if parentheses are opened with a space, add a matching space
    -- after the cursor
    vim.g.delimitMate_expand_space = 1
  end
}
