import { useMemo, useState } from 'react';
import { useLeadGenStore } from '../../stores/leadGenStore';
import './LeadGenWorkspace.css';

export function LeadGenWorkspace({ onExit }: { onExit: () => void }) {
  const prospects = useLeadGenStore((state) => state.prospects);
  const campaigns = useLeadGenStore((state) => state.campaigns);
  const searchQuery = useLeadGenStore((state) => state.searchQuery);
  const selectedProspectId = useLeadGenStore((state) => state.selectedProspectId);
  const setSearchQuery = useLeadGenStore((state) => state.setSearchQuery);
  const selectProspect = useLeadGenStore((state) => state.selectProspect);
  const addProspect = useLeadGenStore((state) => state.addProspect);
  const updateProspect = useLeadGenStore((state) => state.updateProspect);
  const addProspectNote = useLeadGenStore((state) => state.addProspectNote);
  const deleteProspect = useLeadGenStore((state) => state.deleteProspect);
  const addCampaign = useLeadGenStore((state) => state.addCampaign);
  const updateCampaign = useLeadGenStore((state) => state.updateCampaign);
  const attachProspectToCampaign = useLeadGenStore((state) => state.attachProspectToCampaign);
  const detachProspectFromCampaign = useLeadGenStore((state) => state.detachProspectFromCampaign);
  const deleteCampaign = useLeadGenStore((state) => state.deleteCampaign);
  const [leadDraft, setLeadDraft] = useState({ name: '', company: '', role: '', email: '', source: 'Manual' });
  const [campaignDraft, setCampaignDraft] = useState({ name: '', audience: '', offer: '', channel: 'Email' });
  const [noteDraft, setNoteDraft] = useState('');

  const filteredProspects = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return prospects;
    return prospects.filter((prospect) =>
      [prospect.name, prospect.company, prospect.role, prospect.email, prospect.source, prospect.tags.join(' ')]
        .join(' ')
        .toLowerCase()
        .includes(query)
    );
  }, [prospects, searchQuery]);

  const selectedProspect = prospects.find((prospect) => prospect.id === selectedProspectId) ?? null;
  const activeCampaignCount = campaigns.filter((campaign) => campaign.status === 'active').length;
  const highIntentCount = prospects.filter((prospect) => prospect.score >= 75).length;

  function handleCreateProspect() {
    const created = addProspect(leadDraft);
    if (!created) return;
    setLeadDraft({ name: '', company: '', role: '', email: '', source: 'Manual' });
  }

  function handleCreateCampaign() {
    const created = addCampaign(campaignDraft);
    if (!created) return;
    setCampaignDraft({ name: '', audience: '', offer: '', channel: 'Email' });
  }

  function handleAddNote() {
    if (!selectedProspect) return;
    addProspectNote(selectedProspect.id, noteDraft);
    setNoteDraft('');
  }

  return (
    <div className="feature-leadgen animate-rise">
      <section className="feature-leadgen__main">
        <header className="feature-leadgen__header">
          <div>
            <div className="feature-leadgen__eyebrow">Lead Gen</div>
            <h2>Prospecting Workspace</h2>
          </div>
          <div className="feature-leadgen__stats">
            <div><span>Prospects</span><strong>{prospects.length}</strong></div>
            <div><span>High Intent</span><strong>{highIntentCount}</strong></div>
            <div><span>Active Campaigns</span><strong>{activeCampaignCount}</strong></div>
          </div>
          <button type="button" className="feature-leadgen__back" onClick={onExit}>Close</button>
        </header>

        <div className="feature-leadgen__toolbar">
          <input
            className="feature-leadgen__input"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search prospects, companies, or tags"
          />
        </div>

        <div className="feature-leadgen__content">
          <section className="feature-leadgen__panel">
            <div className="feature-leadgen__panel-head">
              <div>
                <div className="feature-leadgen__eyebrow">Prospects</div>
                <h3>Pipeline</h3>
              </div>
            </div>
            <div className="feature-leadgen__list">
              {filteredProspects.length === 0 ? <div className="feature-leadgen__empty">No prospects yet.</div> : null}
              {filteredProspects.map((prospect) => (
                <button
                  key={prospect.id}
                  type="button"
                  className={`feature-leadgen__prospect ${prospect.id === selectedProspectId ? 'is-active' : ''}`}
                  onClick={() => selectProspect(prospect.id)}
                >
                  <strong>{prospect.name}</strong>
                  <span>{prospect.company || 'Independent'} - {prospect.role || 'Prospect'}</span>
                  <small>{prospect.status} - Score {prospect.score}</small>
                </button>
              ))}
            </div>
          </section>

          <section className="feature-leadgen__panel">
            <div className="feature-leadgen__panel-head">
              <div>
                <div className="feature-leadgen__eyebrow">Create</div>
                <h3>Add Prospect</h3>
              </div>
            </div>
            <div className="feature-leadgen__form">
              <input className="feature-leadgen__input" value={leadDraft.name} onChange={(event) => setLeadDraft((current) => ({ ...current, name: event.target.value }))} placeholder="Full name" />
              <input className="feature-leadgen__input" value={leadDraft.company} onChange={(event) => setLeadDraft((current) => ({ ...current, company: event.target.value }))} placeholder="Company" />
              <input className="feature-leadgen__input" value={leadDraft.role} onChange={(event) => setLeadDraft((current) => ({ ...current, role: event.target.value }))} placeholder="Role" />
              <input className="feature-leadgen__input" value={leadDraft.email} onChange={(event) => setLeadDraft((current) => ({ ...current, email: event.target.value }))} placeholder="Email" />
              <input className="feature-leadgen__input" value={leadDraft.source} onChange={(event) => setLeadDraft((current) => ({ ...current, source: event.target.value }))} placeholder="Source" />
              <button type="button" className="feature-leadgen__primary" onClick={handleCreateProspect}>Save Prospect</button>
            </div>

            <div className="feature-leadgen__panel-head feature-leadgen__panel-head--stack">
              <div>
                <div className="feature-leadgen__eyebrow">Campaigns</div>
                <h3>Outbound Plays</h3>
              </div>
            </div>
            <div className="feature-leadgen__form">
              <input className="feature-leadgen__input" value={campaignDraft.name} onChange={(event) => setCampaignDraft((current) => ({ ...current, name: event.target.value }))} placeholder="Campaign name" />
              <input className="feature-leadgen__input" value={campaignDraft.audience} onChange={(event) => setCampaignDraft((current) => ({ ...current, audience: event.target.value }))} placeholder="Audience" />
              <input className="feature-leadgen__input" value={campaignDraft.offer} onChange={(event) => setCampaignDraft((current) => ({ ...current, offer: event.target.value }))} placeholder="Offer" />
              <input className="feature-leadgen__input" value={campaignDraft.channel} onChange={(event) => setCampaignDraft((current) => ({ ...current, channel: event.target.value }))} placeholder="Channel" />
              <button type="button" className="feature-leadgen__primary" onClick={handleCreateCampaign}>Create Campaign</button>
            </div>
            <div className="feature-leadgen__campaigns">
              {campaigns.map((campaign) => {
                const selectedAttached = selectedProspect ? campaign.leadIds.includes(selectedProspect.id) : false;
                return (
                  <div key={campaign.id} className="feature-leadgen__campaign">
                    <strong>{campaign.name}</strong>
                    <span>{campaign.channel} - {campaign.status}</span>
                    <small>{campaign.leadIds.length} attached leads</small>
                    <div className="feature-leadgen__campaign-fields">
                      <input
                        className="feature-leadgen__input"
                        value={campaign.audience}
                        onChange={(event) => updateCampaign(campaign.id, { audience: event.target.value })}
                        placeholder="Audience"
                      />
                      <input
                        className="feature-leadgen__input"
                        value={campaign.offer}
                        onChange={(event) => updateCampaign(campaign.id, { offer: event.target.value })}
                        placeholder="Offer"
                      />
                      <div className="feature-leadgen__campaign-actions">
                        <select value={campaign.status} onChange={(event) => updateCampaign(campaign.id, { status: event.target.value as never })}>
                          {['draft', 'active', 'paused', 'completed'].map((option) => (
                            <option key={option} value={option}>{option}</option>
                          ))}
                        </select>
                        {selectedProspect ? (
                          selectedAttached ? (
                            <button type="button" className="feature-leadgen__ghost" onClick={() => detachProspectFromCampaign(campaign.id, selectedProspect.id)}>
                              Detach Selected Lead
                            </button>
                          ) : (
                            <button type="button" className="feature-leadgen__ghost" onClick={() => attachProspectToCampaign(campaign.id, selectedProspect.id)}>
                              Attach Selected Lead
                            </button>
                          )
                        ) : null}
                        <button type="button" className="feature-leadgen__danger" onClick={() => deleteCampaign(campaign.id)}>
                          Delete Campaign
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="feature-leadgen__panel">
            <div className="feature-leadgen__panel-head">
              <div>
                <div className="feature-leadgen__eyebrow">Detail</div>
                <h3>{selectedProspect?.name || 'Select a Prospect'}</h3>
              </div>
            </div>
            {selectedProspect ? (
              <div className="feature-leadgen__detail">
                <label className="feature-leadgen__field">
                  <span>Status</span>
                  <select value={selectedProspect.status} onChange={(event) => updateProspect(selectedProspect.id, { status: event.target.value as never })}>
                    {['new', 'researching', 'contacted', 'qualified', 'meeting', 'proposal', 'won', 'lost'].map((option) => (
                      <option key={option} value={option}>{option}</option>
                    ))}
                  </select>
                </label>
                <label className="feature-leadgen__field">
                  <span>Score</span>
                  <input type="range" min="0" max="100" value={selectedProspect.score} onChange={(event) => updateProspect(selectedProspect.id, { score: Number(event.target.value) })} />
                </label>
                <label className="feature-leadgen__field">
                  <span>Next Action</span>
                  <input className="feature-leadgen__input" value={selectedProspect.nextAction} onChange={(event) => updateProspect(selectedProspect.id, { nextAction: event.target.value })} />
                </label>
                <div className="feature-leadgen__notes">
                  <textarea className="feature-leadgen__textarea" value={noteDraft} onChange={(event) => setNoteDraft(event.target.value)} placeholder="Add research note, talking point, or follow-up context" rows={4} />
                  <button type="button" className="feature-leadgen__primary" onClick={handleAddNote}>Add Note</button>
                </div>
                <div className="feature-leadgen__note-list">
                  {selectedProspect.notes.map((note) => (
                    <div key={note.id} className="feature-leadgen__note">
                      <strong>{new Date(note.createdAt).toLocaleDateString()}</strong>
                      <p>{note.body}</p>
                    </div>
                  ))}
                </div>
                <button type="button" className="feature-leadgen__danger" onClick={() => deleteProspect(selectedProspect.id)}>Delete Prospect</button>
              </div>
            ) : (
              <div className="feature-leadgen__empty">Choose a prospect to manage outreach, notes, and campaign placement.</div>
            )}
          </section>
        </div>
      </section>
    </div>
  );
}
