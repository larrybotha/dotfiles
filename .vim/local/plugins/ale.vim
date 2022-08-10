" don't use ale for LSP
let g:ale_disable_lsp = 1
let g:ale_use_global_executables = 1
let g:ale_fix_on_save = 1

let g:ale_javascript_eslint_executable = 'eslint_d'
let g:ale_javascript_prettier_executable = 'prettier'
let g:ale_lua_luacheck_options = '--globals vim'

let g:ale_linters = {
  \ 'python': ['pyright', 'mypy', 'pylint', 'flake8'],
  \ 'rust': ['analyzer']
\}

let g:ale_fixers = {
  \ 'graphql': ['custom_prettierd'],
  \ 'hcl': ['terraform'],
  \ 'html': [],
  \ 'javascript': ['custom_prettierd', 'eslint'],
  \ 'javascriptreact': ['custom_prettierd', 'eslint'],
  \ 'json': ['custom_prettierd', 'fixjson'],
  \ 'lua': ['luafmt'],
  \ 'markdown': ['custom_prettierd'],
  \ 'php': ['custom_prettier_php'],
  \ 'python': [ 'isort', 'autoimport', 'black'],
  \ 'rust': ['rustfmt'],
  \ 'sh': ['shfmt'],
  \ 'sql': ['pgformatter'],
  \ 'svelte': ['custom_prettierd'],
  \ 'svg': ['custom_prettier_html'],
  \ 'terraform': ['terraform'],
  \ 'typescript': ['custom_prettierd', 'eslint'],
  \ 'typescriptreact': ['custom_prettierd', 'eslint'],
  \ 'vue': ['custom_prettierd'],
  \ 'yaml': ['custom_prettierd'],
\}

let g:ale_linters_ignore = {'php': ['phpcs'], 'svelte': ['eslint']}

"format .html.php files with custom prettier formats
let g:ale_pattern_options = {
  \ '\.html\.php$': {
    \ 'ale_fixers': ['custom_prettier_html', 'custom_prettier_php'],
  \ },
  \ '\.svelte$': {
    \ 'ale_fixers': ['custom_prettierd'],
  \ },
  \ '\.svx$': {
    \ 'ale_fixers': ['custom_prettierd'],
  \ },
  \ '\.yml\.example$': {
    \ 'ale_fixers': ['prettier'],
  \ },
\}

function! GetPrettierFixer(...)
  let l:options = join(a:000, ' ')

  return {
    \ 'command': join(['prettier', '--stdin-filepath %s', '--stdin', options])
  \}
endfunction

" add prettierd fixer
function! PrettierDOutput(buffer) abort
  let l:options = join(a:000, ' ')

  return {
        \ 'command': join(['prettierd', '%s', options])
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
execute ale#fix#registry#Add('custom_prettierd', 'PrettierDOutput', [], 'format with prettierd')
execute ale#fix#registry#Add('custom_prettier_html', 'PrettierHtmlOutput', [], 'format html with prettier')
execute ale#fix#registry#Add('custom_prettier_php', 'PrettierPhpOutput', [], 'format php with prettier')
execute ale#fix#registry#Add('custom_prettier_vanilla', 'PrettierVanillaOutput', [], 'format with standard prettier')
