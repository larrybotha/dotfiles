" don't use ale for LSP
let g:ale_disable_lsp = 1
let g:ale_use_global_executables = 1
let g:ale_fix_on_save = 1

let g:ale_javascript_eslint_executable = 'eslint_d'
let g:ale_javascript_prettier_executable = 'prettier_d_slim'
let g:ale_lua_luacheck_options = '--globals vim'

let g:ale_fixers = {
  \ 'graphql': ['prettier'],
  \ 'html': ['prettier'],
  \ 'javascript': ['prettier', 'eslint'],
  \ 'javascriptreact': ['prettier', 'eslint'],
  \ 'json': ['custom_prettier_vanilla', 'fixjson'],
  \ 'lua': ['luafmt'],
  \ 'markdown': ['prettier'],
  \ 'php': ['custom_prettier_php'],
  \ 'python': [ 'isort', 'autoimport', 'black'],
  \ 'sh': ['shfmt'],
  \ 'svelte': ['prettier'],
  \ 'typescript': ['prettier', 'eslint'],
  \ 'typescriptreact': ['prettier', 'eslint'],
  \ 'vue': ['prettier'],
  \ 'yaml': ['prettier'],
\}

let g:ale_linters_ignore = {'php': ['phpcs'], 'svelte': ['eslint']}

"format .html.php files with custom prettier formats
let g:ale_pattern_options = {
  \ '\.html\.php$': {
    \ 'ale_fixers': ['custom_prettier_html', 'custom_prettier_php'],
  \ },
\}

function! GetPrettierFixer(...)
  let l:options = join(a:000, ' ')

  return {
    \ 'command': join(['prettier', '--stdin-filepath %s', '--stdin', options])
  \}
endfunction

" add custom html prettier formatter
function! PrettierHtmlOutput(buffer) abort
  return GetPrettierFixer('--parser html')
endfunction

" add custom php prettier formatter
function! PrettierPhpOutput(buffer) abort
  return GetPrettierFixer('--parser php')
endfunction

" add custom vanilla prettier formatter
function! PrettierVanillaOutput(buffer) abort
  return GetPrettierFixer('')
endfunction

" add custom fixers to Ale's registry
execute ale#fix#registry#Add('custom_prettier_html', 'PrettierHtmlOutput', [], 'format html with prettier')
execute ale#fix#registry#Add('custom_prettier_php', 'PrettierPhpOutput', [], 'format php with prettier')
execute ale#fix#registry#Add('custom_prettier_vanilla', 'PrettierVanillaOutput', [], 'format with standard prettier')
