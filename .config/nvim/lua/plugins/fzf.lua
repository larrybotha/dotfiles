M = {}

M.lazy_config = {
  'junegunn/fzf.vim',

  dependencies = {
    {'junegunn/fzf',
    build = ":fzf#install"
  }
  }

}

return M
