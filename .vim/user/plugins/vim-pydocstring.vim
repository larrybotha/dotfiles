augroup custom_pydocstring
  autocmd! custom_pydocstring
  " map pydocstring from <C-L> to <C-_>
  autocmd Filetype python nmap <silent> <C-_> <Plug>(pydocstring)
augroup END
