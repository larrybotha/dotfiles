return {
  'tpope/vim-endwise',
  name ="vim-endwise",
  init = function()
    -- stop endwise interfering with pumvisible
    vim.g.endwise_no_mappings = 1
  end
}
