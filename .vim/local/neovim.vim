if has("nvim")
  " Configure Python virtual environment for neovim
  "
  " Run :checkhealth to determine if python3_host_prog is pointing to the
  " virtualenv python binary
  "
  " see :help provider-python for virtualenv config instructions
  let _python3_host_prog = expand("$HOME/.pyenv/versions/py3nvim/bin/python")

  if filereadable(_python3_host_prog)
    let g:python3_host_prog = _python3_host_prog
  else
    echo 'neovim python virtualenv is not configured. See' expand('%:p')
  endif
endif
