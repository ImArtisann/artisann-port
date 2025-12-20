import {createFileRoute} from '@tanstack/react-router'
import {Button} from "@/components/ui/button.tsx";
import {openSourceProjects, personalProjects, workExperiences} from "@/lib/about-me.ts";
import {Badge} from "@/components/ui/badge.tsx";
import {Moon, Sun} from "lucide-react";
import {useTheme} from "@/components/theme-provider.tsx";
import * as React from "react";

export const Route = createFileRoute('/')({ component: App })

function App() {

  const {theme, setTheme} = useTheme()
  const [isExpanded, setIsExpanded] = React.useState(false);

  return (
    <div className="min-h-screen bg-background">
      <header className={'mx-auto max-w-4xl px-6 pt-14'}>
        <div className={'flex flex-row items-center justify-between'}>
          <div className={'flex flex-col gap-4 items-start'}>
            <h1 className={'text-4xl md:text-6xl font-bold text-foreground'}>
              Artisann
            </h1>
            <div className={'flex flex-row gap-2 items-center'}>
              <a href={'https://github.com/ImArtisann'} target="_blank" rel="noreferrer" className={'text-md text-foreground hover:underline'}>
                GitHub
              </a>
              <span className={'text-md text-muted-foreground'}>/</span>
              <a href={'https://x.com/IArtisann'} target="_blank" rel="noreferrer" className={'text-md text-foreground hover:underline'}>
                Twitter
              </a>
            </div>
          </div>
          <Button
            variant={'ghost'} size={'icon'}
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          >
            {theme === 'dark' ? (<Sun className={'h-5 w-5'}/>) : (<Moon className={'h-5 w-5'}/>)}

          </Button>
        </div>
      </header>
      <section className={'mx-auto max-w-4xl px-6 pt-14'}>
        <div className={'flex flex-col gap-4'}>
          <h2 className={'font-semibold text-muted-foreground'}>
            Experience
          </h2>
          <div className={'flex flex-col w-full gap-4'}>
            {workExperiences.map((experience, index) => (
                <button
                    type="button"
                    key={`${experience.company}-${index}`}
                    className={'group flex flex-col w-full gap-2 text-left cursor-pointer md:cursor-default focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm'}
                    onClick={() => setIsExpanded(!isExpanded)}
                >
                  <div  className={'flex flex-row w-full items-center justify-between'}>
                    <div className={'flex flex-row items-center gap-4'}>
                      <img src={experience.logo} alt={'My Cat Milo'} className={'h-6 w-auto'}/>
                    <div className={'flex flex-col gap-1 items-start'}>
                      <h3 className={'text-sm md:text-base font-semibold text-foreground'}>
                        {experience.company}
                      </h3>
                      <div className={'flex flex-col md:flex-row gap-2 items-start'}>
                        <span className={'text-xs md:text-sm text-foreground/80'}>
                        {experience.role}
                        </span>
                        <span className={'text-xs md:text-sm text-muted-foreground'}>
                          {experience.technologies.join(', ')}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className={'flex flex-row gap-2 items-center text-xs md:text-sm text-muted-foreground'}>
                    <p>{experience.start}</p>
                    <p>-</p>
                    <p>{experience.end}</p>
                  </div>
                </div>
                  <div
                      className={'max-h-0 opacity-0 group-hover:max-h-32 group-hover:opacity-100 transition-all duration-300 ease-in-out overflow-hidden'}>
                    <p className={'text-xs md:text-sm text-foreground'}>
                      {experience.description}
                    </p>
                  </div>
                </button>
            ))}
          </div>
        </div>
      </section>
      <section className={'mx-auto max-w-4xl px-6 pt-14'}>
        <div className={'flex flex-col gap-4'}>
          <h2 className={'font-semibold text-muted-foreground'}>
            Apps
          </h2>
          <div className={'flex flex-col gap-4'}>
            {personalProjects.map((app, index) => (
                <div key={`${app.name}-${index}`} className={'flex flex-row w-full items-center justify-start gap-4'}>
                  <div className={'flex flex-col w-full items-start gap-2'}>
                    <div className={'flex flex-row text-sm  w-full items-center justify-between'}>
                    <div className={'flex flex-row text-sm gap-2 items-center'}>
                      <span className={'font-semibold text-lg text-foreground'}>{app.name}</span>
                      {app.link && ( <a href={app.link} target="_blank" rel="noreferrer" className={'text-sm text-muted-foreground underline'}>Link</a>)}
                    </div>
                      {app.badge && <Badge variant={app.badge === 'soon' ? 'default' : 'destructive'} >{app.badge === 'soon' ? 'Soon' : 'Not Supported'}</Badge> }
                    </div>
                    <p className={'text-sm text-foreground/80'}>{app.description}</p>
                    <span className={'text-sm text-muted-foreground'}>
                          {app.technologies.join(', ')}
                        </span>
                  </div>
                </div>
            ))}
          </div>
        </div>
      </section>
      <section className={'mx-auto max-w-4xl px-6 py-14'}>
        <div className={'flex flex-col gap-4'}>
          <h2 className={'font-semibold text-muted-foreground'}>
            Open Source
          </h2>
          <div className={'flex flex-col gap-4'}>
            {openSourceProjects.map((app, index) => (
                <div key={`${app.name}-${index}`} className={'flex flex-row w-full items-center justify-start gap-4'}>
                  <div className={'flex flex-col w-full items-start gap-2'}>
                    <div className={'flex flex-row text-sm  w-full items-center justify-between'}>
                      <div className={'flex flex-row text-sm gap-2 items-center'}>
                        <span className={'font-semibold text-lg text-foreground'}>{app.name}</span>
                      </div>
                      <a href={app.link} target="_blank" rel="noreferrer" className={'text-sm text-muted-foreground underline'}>Link</a>
                    </div>
                    <p className={'text-sm text-foreground/80'}>{app.description}</p>
                    <span className={'text-sm text-muted-foreground'}>
                          {app.technologies.join(', ')}
                        </span>
                  </div>
                </div>
            ))}
          </div>
        </div>
      </section>
      <div className={'fixed bottom-4 left-4 md:bottom-6 md:left-6 z-50'}>
        <img
            src={'/Milo.png'}
            alt={'My Cat Milo'}
            className={'h-16 w-auto md:h-56 transition-all duration-300'}
        />
      </div>
    </div>
  )
}
