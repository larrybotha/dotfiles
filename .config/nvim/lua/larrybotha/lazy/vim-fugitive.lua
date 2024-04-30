return {
  'tpope/vim-fugitive',
  name ="vim-fugitive",
  init = function()
    vim.keymap.set("n", "<leader>gp", "nmap <leader>gp :exec ':git push origin ' . fugitive#head()<cr>") -- git push
    vim.keymap.set("", "<leader>gs", ":Git<CR>", {silent=true})                                          -- git status
    vim.keymap.set("", "<leader>gci", ":Git commit -am '")                                               -- git commit -am
    vim.keymap.set("", "<leader>gco", ":Git checkout<space>")                                            -- git checkout

    -- git diff
    --vim.keymap.set("", "<leader>gd", ":Gdiff")
  end
}
