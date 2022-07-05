"" See: https://github.com/christoomey/vim-tmux-navigator/issues/295#issuecomment-1123455337
function! s:set_is_vim()
  silent execute '!tmux set-option -p @custom_is_vim yes'
endfunction

function! s:unset_is_vim()
  silent execute '!tmux set-option -p -u @custom_is_vim'
endfunction


if has("autocmd")
  autocmd!
  autocmd VimEnter * call s:set_is_vim()
  autocmd VimLeave * call s:unset_is_vim()

  " handle suspending and resuming vim
  if exists("##VimSuspend")
    autocmd VimSuspend * call s:unset_is_vim()
    autocmd VimResume * call s:set_is_vim()
  endif
endif
