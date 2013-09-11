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
bundle 'ervandew/supertab'
bundle 'kchmck/vim-coffee-script'
bundle 'ddollar/nerdcommenter'
bundle 'tpope/vim-endwise'
bundle 'ecomba/vim-ruby-refactoring'
bundle 'scrooloose/syntastic'
bundle 'scrooloose/nerdtree'
bundle 'shawncplus/phpcomplete.vim'
bundle 'godlygeek/tabular'
bundle 'majutsushi/tagbar'
bundle 'lokaltog/vim-powerline'
bundle 'jistr/vim-nerdtree-tabs'
bundle 'terryma/vim-multiple-cursors'
bundle 'guns/vim-clojure-static'
bundle 'tpope/vim-fireplace'
bundle 'jwhitley/vim-matchit'
bundle 'joonty/vdebug.git'
bundle 'mattn/emmet-vim'

autocmd bufnewfile,bufreadpost * set ai ts=2 sw=2 sts=2 et

" check for external file changes
autocmd cursorhold,cursormoved,bufenter * checktime

syntax on
let g:powerline_symbols = 'fancy'
let delimitmate_expand_cr = 1
let delimitmate_expand_space = 1
let g:nerdtree_tabs_open_on_console_startup = 1
let nerdtreeshowhidden=1
let g:ctrlp_max_height = 25
let g:ctrlp_show_hidden = 1
let g:syntastic_check_on_open=1

filetype plugin indent on

set t_co=256
colorscheme monokai

set splitright
set splitbelow

if has('mouse_sgr')
  set ttymouse=sgr
endif

let &t_si = "\<esc>]50;cursorshape=1\x7"
let &t_ei = "\<esc>]50;cursorshape=0\x7"

" line highlighting
set cursorline
hi cursorline term=bold cterm=bold ctermbg=233

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

" (hopefully) removes the delay when hitting esc in insert mode
set noesckeys
set ttimeout
set ttimeoutlen=1

set showmatch
" show timeout on leader
set showcmd

set wildmenu
set wildmode=longest,list

" switch relative line numbers to absolute when vim is not in focus
:au focuslost * :set number
:au focusgained * :set relativenumber

" use absolute numbers when in insert mode
autocmd insertenter * :set number
autocmd insertleave * :set relativenumber

let mapleader=","
inoremap <c-s> <c-c>:w<cr>
map <c-s> <c-c>:w<cr>

" navigate panes with <c-hhkl>
nmap <silent> <c-k> :wincmd k<cr>
nmap <silent> <c-j> :wincmd j<cr>
nmap <silent> <c-h> :wincmd h<cr>
nmap <silent> <c-l> :wincmd l<cr>

" quickly remove highlighted searches
nmap <silent> ,/ :nohlsearch<cr>

map <leader>. :noh<cr>
map <leader>n :nerdtreetabstoggle<cr>
map <leader>ff :nerdtreefind<cr>

" paste, fix indentation and clear the mark by default
nnoremap p p=`]`<esc>

" ahoq trailing white space
:highlight extrawhitespace ctermbg=red guibg=red
:match extrawhitespace /\s\+$/

" clear trailing white space across file
nnoremap <leader>t :%s/\s\+$//<cr>:let @/=''<cr>

nmap <leader>gp :exec ':git push origin ' . fugitive#head()<cr>
nmap <leader>ghp :exec ':git push heroku ' . fugitive#head()<cr>
nmap <leader>bx :!bundle exec<space>
nmap <leader>zx :!zeus<space>
map <leader>vbi :bundleinstall<cr>
map <leader>vbu :bundleupdate<cr>

map <leader>bi :!bundle<cr>
map <leader>bu :!bundle update<space>

map <leader>vi :tabe ~/dotfiles/.vimrc<cr>
map <leader>td :tabe ~/dropbox/todo.txt<cr>
map <leader>tb :tabe ~/dropbox/blog.txt<cr>
map <leader>vs :source ~/.vimrc<cr>

map <silent> <leader>gs :gstatus<cr>/not staged<cr>/modified<cr>
map <leader>gc :gcommit<cr>
map <leader>gw :!git add . && git commit -m "wip"

map <leader>bn :bn<cr>
map <leader>bp :bp<cr>

map <leader>tp :tabp<cr>
map <leader>tn :tabn<cr>

map <leader>= <c-w>=

" emacs-like beginning and end of line.
imap <c-e> <c-o>$
imap <c-a> <c-o>^

map <leader>tt :tabularize /=<cr>

map <leader>rt :call runcurrenttest()<cr>
map <leader>rl :call runcurrentlineintest()<cr>
map <leader>rrt :call runcurrenttestnozeus()<cr>
map <leader>rrl :call runcurrentlineintestnozeus()<cr>
map <leader>rj :!~/code/chrome-reload<cr><cr>

map <leader>sm :rsmodel<space>
map <leader>vc :rvcontroller<cr>
map <leader>vm :rvmodel<space>
map <leader>vv :rvview<cr>
map <leader>zv :rview<cr>
map <leader>zc :rcontroller<cr>
map <leader>zm :rmodel<space>

" pane management
map <leader>mh :wincmd h<cr>
map <leader>mj :wincmd j<cr>
map <leader>mk :wincmd k<cr>
map <leader>ml :wincmd l<cr>

" flip left and right panes
map <leader>mm :nerdtreetabsclose<cr>:wincmd l<cr>:wincmd h<cr>:nerdtreetabsopen<cr>:wincmd l<cr><c-w>=

" restart pow
map <leader>rp :!touch tmp/restart.txt<cr><cr>

" select the current method in ruby (or it block in rspec)
map <leader>sm /end<cr>?\<def\>\\|\<it\><cr>:noh<cr>v%
map <leader>sf :e spec/factories/

" j and k navigate through wrapped lines
nmap k gk
nmap j gj

" quickly move lines up and down
nnoremap <A-j> :m .+1<CR>==
nnoremap <A-k> :m .-2<CR>==
inoremap <A-j> <Esc>:m .+1<CR>==gi
inoremap <A-k> <Esc>:m .-2<CR>==gi
vnoremap <A-j> :m '>+1<CR>gv=gv
vnoremap <A-k> :m '<-2<CR>gv=gv

command! q q " bind :q to :q
command! qall qall

command! w w
command! wa wall

" deprecated? must check new docs.
autocmd user rails rnavcommand presenter app/presenters -glob=**/* -suffix=.rb

" set up some useful rails.vim bindings for working with backbone.js
autocmd user rails rnavcommand template    app/assets/templates               -glob=**/*  -suffix=.jst.ejs
autocmd user rails rnavcommand jmodel      app/assets/javascripts/models      -glob=**/*  -suffix=.coffee
autocmd user rails rnavcommand jview       app/assets/javascripts/views       -glob=**/*  -suffix=.coffee
autocmd user rails rnavcommand jcollection app/assets/javascripts/collections -glob=**/*  -suffix=.coffee
autocmd user rails rnavcommand jrouter     app/assets/javascripts/routers     -glob=**/*  -suffix=.coffee
autocmd user rails rnavcommand jspec       spec/javascripts                   -glob=**/*  -suffix=.coffee

" use the silver searcher https://github.com/ggreer/the_silver_searcher
" source: https://github.com/thoughtbot/dotfiles/blob/master/vimrc
if executable('ag')
  " use ag over grep
  set grepprg=ag\ --nogroup\ --nocolor

  " use ag in ctrlp for listing files. lightning fast and respects .gitignore
  let g:ctrlp_user_command = 'ag %s -l --nocolor -g ""'
endif

if has("autocmd")
  " also load indent files, to automatically do language-dependent indenting.

  " put these in an autocmd group, so that we can delete them easily.
  augroup vimrcex
  au!

  " for all text files set 'textwidth' to 78 characters.
  autocmd filetype text setlocal textwidth=78

  " never wrap slim files
  autocmd filetype slim setlocal textwidth=0

  autocmd bufwritepre * :%s/\s\+$//e

  " when editing a file, always jump to the last known cursor position.
  " don't do it when the position is invalid or when inside an event handler
  " (happens when dropping a file on gvim).
  autocmd bufreadpost *
    \ if line("'\"") > 0 && line("'\"") <= line("$") |
    \   exe "normal g`\"" |
    \ endif

  augroup end

endif " has("autocmd")

""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""
" test-running stuff, thanks @r00k!
""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""
function! runcurrenttest()
  let in_test_file = match(expand("%"), '\(.feature\|_spec.rb\|_test.rb\)$') != -1
  if in_test_file
    call settestfile()

    if match(expand('%'), '\.feature$') != -1
      call settestrunner("!zeus cucumber")
      exec g:bjo_test_runner g:bjo_test_file
    elseif match(expand('%'), '_spec\.rb$') != -1
      call settestrunner("!zeus rspec")
      exec g:bjo_test_runner g:bjo_test_file
    else
      call settestrunner("!ruby -itest")
      exec g:bjo_test_runner g:bjo_test_file
    endif
  else
    exec g:bjo_test_runner g:bjo_test_file
  endif
endfunction

function! runcurrenttestnozeus()
  let in_test_file = match(expand("%"), '\(.feature\|_spec.rb\|_test.rb\)$') != -1

  if in_test_file
    call settestfile()
  endif

  exec "!rspec" g:bjo_test_file
endfunction

function! runcurrentlineintestnozeus()
  let in_test_file = match(expand("%"), '\(.feature\|_spec.rb\|_test.rb\)$') != -1
  if in_test_file
    call settestfilewithline()
  end

  exec "!rspec" g:bjo_test_file . ":" . g:bjo_test_file_line
endfunction

function! settestrunner(runner)
  let g:bjo_test_runner=a:runner
endfunction

function! runcurrentlineintest()
  let in_test_file = match(expand("%"), '\(.feature\|_spec.rb\|_test.rb\)$') != -1
  if in_test_file
    call settestfilewithline()
  end

  exec "!zeus rspec" g:bjo_test_file . ":" . g:bjo_test_file_line
endfunction

function! settestfile()
  let g:bjo_test_file=@%
endfunction

function! settestfilewithline()
  let g:bjo_test_file=@%
  let g:bjo_test_file_line=line(".")
endfunction
