" NB: Vimux ONLY runs inside an instance of Vim already running in a tmux
" session!

 " Run the current file with rspec
"nnoremap <Leader>rb :call VimuxRunCommand("clear; rspec " . bufname("%"))<CR>
 " Prompt for a command to run
nnoremap <Leader>vp :VimuxPromptCommand<CR>
 " Run last command executed by VimuxRunCommand
nnoremap <Leader>vl :VimuxRunLastCommand<CR>
 " Inspect runner pane
nnoremap <Leader>vi :VimuxInspectRunner<CR>
 " Close vim tmux runner opened by VimuxRunCommand
nnoremap <Leader>vq :VimuxCloseRunner<CR>
 " Interrupt any command running in the runner pane
nnoremap <Leader>vx :VimuxInterruptRunner<CR>
 " Zoom the runner pane (use <bind-key> z to restore runner pane)
nnoremap <Leader>vz :call VimuxZoomRunner()<CR>
 " Clear the terminal screen of the runner pane.
nnoremap <Leader>v<C-l> :VimuxClearTerminalScreen<CR>

" vertical orientation
let g:VimuxOrientation = "h"
" percentage of screen runner should occupy
let g:VimuxHeight = "30"
