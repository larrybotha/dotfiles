return {
  {
    'mattn/emmet-vim',
    name ="emmet-vim",
    init = function()
      vim.g.user_emmet_settings = [[ {
        \ 'indentation': '  ',
        \ 'javascript.jsx' : {
        \     'extends' : 'jsx',
        \ },
        \}
      ]]
    end
  }
}
