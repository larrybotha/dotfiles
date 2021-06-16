" NB: Vimux ONLY runs inside an instance of Vim already running in a tmux
" session!

" Run the current file with rspec
"nnoremap <Leader>rb :call VimuxRunCommand("clear; rspec " . bufname("%"))<CR>
" Prompt for a command to run
nnoremap <Leader>vmp :VimuxPromptCommand<CR>
" Run last command executed by VimuxRunCommand
nnoremap <Leader>vml :VimuxRunLastCommand<CR>
" Inspect runner pane
nnoremap <Leader>vmi :VimuxInspectRunner<CR>
" Close vim tmux runner opened by VimuxRunCommand
nnoremap <Leader>vmq :VimuxCloseRunner<CR>
" Interrupt any command running in the runner pane
nnoremap <Leader>vmo :VimuxOpenRunner<CR>
" Interrupt any command running in the runner pane
nnoremap <Leader>vmx :VimuxInterruptRunner<CR>
" Clear the terminal screen of the runner pane.
nnoremap <Leader>vm<C-l> :VimuxClearTerminalScreen<CR>

" vertical orientation
let g:VimuxOrientation = "h"
" percentage of screen runner should occupy
let g:VimuxHeight = "30"
