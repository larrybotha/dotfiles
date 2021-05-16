" open quickfix window automatically
let g:asyncrun_open = 6
let g:asynctasks_term_pos = 'right'

" load from .config folder
let g:asynctasks_extra_config = [
\ '~/.config/asynctasks/tasks.ini',
\]

"let g:asynctasks_term_pos = 'tmux'
"function! s:run_tmux(opts)
    "" asyncrun has temporarily changed dir for you
    "" getcwd() in the runner function is the target directory defined in `-cwd=xxx`
    "let cwd = getcwd()
    ""call VimuxRunCommand('cd ' . shellescape(cwd) . '; ' . a:opts.cmd)
    "call VimuxRunCommand(a:opts.cmd)
"endfunction

"let g:asyncrun_runner = get(g:, 'asyncrun_runner', {})
"let g:asyncrun_runner.tmux = function('s:run_tmux')
