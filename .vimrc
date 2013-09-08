set rtp+=~/.vim/bundle/vundle/
call vundle#rc()
Bundle 'gmarik/vundle'

Bundle 'rking/ag.vim'
Bundle 'vim-ruby/vim-ruby'
Bundle 'tpope/vim-rails'
Bundle 'tpope/vim-fugitive'
Bundle 'tpope/vim-surround'
Bundle 'Raimondi/delimitMate'
Bundle 'adamlowe/vim-slurper'
Bundle 'kien/ctrlp.vim'
Bundle 'slim-template/vim-slim'
Bundle 'ervandew/supertab'
Bundle 'kchmck/vim-coffee-script'
Bundle 'ddollar/nerdcommenter'
Bundle 'tpope/vim-endwise'
Bundle 'ecomba/vim-ruby-refactoring'
Bundle 'scrooloose/syntastic'
Bundle 'scrooloose/nerdtree'
Bundle 'godlygeek/tabular'
Bundle 'Lokaltog/vim-powerline'
Bundle 'jistr/vim-nerdtree-tabs'
Bundle 'terryma/vim-multiple-cursors'
Bundle 'guns/vim-clojure-static'
Bundle 'tpope/vim-fireplace'
Bundle 'jwhitley/vim-matchit'
Bundle 'joonty/vdebug.git'
Bundle 'mattn/emmet-vim'

autocmd BufNewFile,BufReadPost * set ai ts=2 sw=2 sts=2 et

" check for external file changes
autocmd CursorHold,CursorMoved,BufEnter * checktime

syntax on
let g:Powerline_symbols = 'fancy'
let delimitMate_expand_cr = 1
let delimitMate_expand_space = 1
let g:nerdtree_tabs_open_on_console_startup = 1
let g:ctrlp_max_height = 25
let g:ctrlp_show_hidden = 1
let g:syntastic_check_on_open=1

filetype plugin indent on

set t_Co=256
colorscheme monokai

set splitright
set splitbelow

if has('mouse_sgr')
  set ttymouse=sgr
endif

let &t_SI = "\<Esc>]50;CursorShape=1\x7"
let &t_EI = "\<Esc>]50;CursorShape=0\x7"

" line highlighting
set cursorline
hi CursorLine term=bold cterm=bold ctermbg=233

set incsearch
set hlsearch
noh " clear the initial highlight after sourcing
set ignorecase smartcase
set relativenumber
set scrolloff=5
set mouse=a
set laststatus=2 " always show the status bar
set nocompatible
set noswapfile
set nobackup
set nowritebackup
set nowrap
set colorcolumn=85 " show column length hint for long lines
set backspace=indent,eol,start " allow backspacing over everything in insert mode
" set clipboard=unnamed

" (Hopefully) removes the delay when hitting esc in insert mode
set noesckeys
set ttimeout
set ttimeoutlen=1

set showmatch
" show timeout on leader
set showcmd

set wildmenu
set wildmode=longest,list

" switch relative line numbers to absolute when Vim is not in focus
:au FocusLost * :set number
:au FocusGained * :set relativenumber

" use absolute numbers when in Insert mode
autocmd InsertEnter * :set number
autocmd InsertLeave * :set relativenumber

let mapleader=","
inoremap <c-s> <c-c>:w<CR>
map <c-s> <c-c>:w<CR>

" navigate panes with <c-hhkl>
nmap <silent> <c-k> :wincmd k<CR>
nmap <silent> <c-j> :wincmd j<CR>
nmap <silent> <c-h> :wincmd h<CR>
nmap <silent> <c-l> :wincmd l<CR>

" quickly remove highlighted searches
nmap <silent> ,/ :nohlsearch<CR>

map <leader>. :noh<CR>
map <leader>n :NERDTreeTabsToggle<CR>
map <leader>ff :NERDTreeFind<CR>

" paste, fix indentation and clear the mark by default
nnoremap p p=`]`<esc>

" ahoq trailing white space
:highlight ExtraWhitespace ctermbg=red guibg=red
:match ExtraWhitespace /\s\+$/

" clear trailing white space across file
nnoremap <leader>T :%s/\s\+$//<cr>:let @/=''<CR>

nmap <leader>gp :exec ':Git push origin ' . fugitive#head()<CR>
nmap <leader>ghp :exec ':Git push heroku ' . fugitive#head()<CR>
nmap <leader>bx :!bundle exec<space>
nmap <leader>zx :!zeus<space>
map <leader>vbi :BundleInstall<CR>
map <leader>vbu :BundleUpdate<CR>

map <leader>bi :!bundle<CR>
map <leader>bu :!bundle update<space>

map <leader>vi :tabe ~/dotfiles/.vimrc<CR>
map <leader>td :tabe ~/Dropbox/todo.txt<CR>
map <leader>tb :tabe ~/Dropbox/blog.txt<CR>
map <leader>vs :source ~/.vimrc<CR>

map <silent> <leader>gs :Gstatus<CR>/not staged<CR>/modified<CR>
map <leader>gc :Gcommit<CR>
map <leader>gw :!git add . && git commit -m "WIP"

map <leader>bn :bn<CR>
map <leader>bp :bp<CR>

map <leader>tp :tabp<CR>
map <leader>tn :tabn<CR>

map <leader>= <C-w>=

" Emacs-like beginning and end of line.
imap <c-e> <c-o>$
imap <c-a> <c-o>^

map <leader>tt :Tabularize /=<CR>

map <leader>rt :call RunCurrentTest()<CR>
map <leader>rl :call RunCurrentLineInTest()<CR>
map <leader>rrt :call RunCurrentTestNoZeus()<CR>
map <leader>rrl :call RunCurrentLineInTestNoZeus()<CR>
map <leader>rj :!~/Code/chrome-reload<CR><CR>

map <leader>sm :RSmodel<space>
map <leader>vc :RVcontroller<CR>
map <leader>vm :RVmodel<space>
map <leader>vv :RVview<CR>
map <leader>zv :Rview<CR>
map <leader>zc :Rcontroller<CR>
map <leader>zm :Rmodel<space>

" pane management
map <leader>mh :wincmd H<CR>
map <leader>mj :wincmd J<CR>
map <leader>mk :wincmd K<CR>
map <leader>ml :wincmd L<CR>

" flip left and right panes
map <leader>mm :NERDTreeTabsClose<CR>:wincmd l<CR>:wincmd H<CR>:NERDTreeTabsOpen<CR>:wincmd l<CR><C-W>=

" restart pow
map <leader>rp :!touch tmp/restart.txt<CR><CR>

" select the current method in ruby (or it block in rspec)
map <leader>sm /end<CR>?\<def\>\\|\<it\><CR>:noh<CR>V%
map <leader>sf :e spec/factories/

" j and k navigate through wrapped lines
nmap k gk
nmap j gj

command! Q q " Bind :Q to :q
command! Qall qall

command! W w
command! Wa wall

" deprecated? must check new docs.
autocmd User Rails Rnavcommand presenter app/presenters -glob=**/* -suffix=.rb

" Set up some useful Rails.vim bindings for working with Backbone.js
autocmd User Rails Rnavcommand template    app/assets/templates               -glob=**/*  -suffix=.jst.ejs
autocmd User Rails Rnavcommand jmodel      app/assets/javascripts/models      -glob=**/*  -suffix=.coffee
autocmd User Rails Rnavcommand jview       app/assets/javascripts/views       -glob=**/*  -suffix=.coffee
autocmd User Rails Rnavcommand jcollection app/assets/javascripts/collections -glob=**/*  -suffix=.coffee
autocmd User Rails Rnavcommand jrouter     app/assets/javascripts/routers     -glob=**/*  -suffix=.coffee
autocmd User Rails Rnavcommand jspec       spec/javascripts                   -glob=**/*  -suffix=.coffee

" Use The Silver Searcher https://github.com/ggreer/the_silver_searcher
" Source: https://github.com/thoughtbot/dotfiles/blob/master/vimrc
if executable('ag')
  " Use Ag over Grep
  set grepprg=ag\ --nogroup\ --nocolor

  " Use ag in CtrlP for listing files. Lightning fast and respects .gitignore
  let g:ctrlp_user_command = 'ag %s -l --nocolor -g ""'
endif

if has("autocmd")
  " Also load indent files, to automatically do language-dependent indenting.

  " Put these in an autocmd group, so that we can delete them easily.
  augroup vimrcEx
  au!

  " For all text files set 'textwidth' to 78 characters.
  autocmd FileType text setlocal textwidth=78

  " Never wrap slim files
  autocmd FileType slim setlocal textwidth=0

  autocmd BufWritePre * :%s/\s\+$//e

  " When editing a file, always jump to the last known cursor position.
  " Don't do it when the position is invalid or when inside an event handler
  " (happens when dropping a file on gvim).
  autocmd BufReadPost *
    \ if line("'\"") > 0 && line("'\"") <= line("$") |
    \   exe "normal g`\"" |
    \ endif

  augroup END

endif " has("autocmd")

""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""
" Test-running stuff, thanks @r00k!
""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""
function! RunCurrentTest()
  let in_test_file = match(expand("%"), '\(.feature\|_spec.rb\|_test.rb\)$') != -1
  if in_test_file
    call SetTestFile()

    if match(expand('%'), '\.feature$') != -1
      call SetTestRunner("!zeus cucumber")
      exec g:bjo_test_runner g:bjo_test_file
    elseif match(expand('%'), '_spec\.rb$') != -1
      call SetTestRunner("!zeus rspec")
      exec g:bjo_test_runner g:bjo_test_file
    else
      call SetTestRunner("!ruby -Itest")
      exec g:bjo_test_runner g:bjo_test_file
    endif
  else
    exec g:bjo_test_runner g:bjo_test_file
  endif
endfunction

function! RunCurrentTestNoZeus()
  let in_test_file = match(expand("%"), '\(.feature\|_spec.rb\|_test.rb\)$') != -1

  if in_test_file
    call SetTestFile()
  endif

  exec "!rspec" g:bjo_test_file
endfunction

function! RunCurrentLineInTestNoZeus()
  let in_test_file = match(expand("%"), '\(.feature\|_spec.rb\|_test.rb\)$') != -1
  if in_test_file
    call SetTestFileWithLine()
  end

  exec "!rspec" g:bjo_test_file . ":" . g:bjo_test_file_line
endfunction

function! SetTestRunner(runner)
  let g:bjo_test_runner=a:runner
endfunction

function! RunCurrentLineInTest()
  let in_test_file = match(expand("%"), '\(.feature\|_spec.rb\|_test.rb\)$') != -1
  if in_test_file
    call SetTestFileWithLine()
  end

  exec "!zeus rspec" g:bjo_test_file . ":" . g:bjo_test_file_line
endfunction

function! SetTestFile()
  let g:bjo_test_file=@%
endfunction

function! SetTestFileWithLine()
  let g:bjo_test_file=@%
  let g:bjo_test_file_line=line(".")
endfunction
