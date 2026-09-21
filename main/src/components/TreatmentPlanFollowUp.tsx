import { useState, useEffect } from 'react';
import { Plus, Edit2, Trash2, X, Save } from 'lucide-react';
import { supabase } from '../Supabase/client';
import { showToast } from '../utils/toast';
import { Modal } from './Modal';

// Types matching Supabase schema
interface TreatmentPlan {
  id: string;
  case_id: string;
  vmtb_discussion_date: string | null;
  participants: string[] | null;
  consensus_predominant_pathway: string | null;
  consensus_therapy_recommendation: string | null;
  amp_level_of_evidence: string | null;
  escat_level: string | null;
  overall_evidence_strength: string | null;
  is_treatment_implemented: boolean | null;
  treatment_initiation_date: string | null;
  treatment_discontinuation_date: string | null;
  treatment_administered: string | null;
  non_implementation_reason: string | null;
  non_implementation_notes: string | null;
  alternative_treatment_plan: string | null;
  created_at: string;
  updated_at: string;
}

interface TreatmentFollowUp {
  id: string;
  treatment_plan_id: string;
  followup_date: string;
  disease_progression_date: string | null;
  current_patient_status: string | null;
  discontinuation_or_ltfu_reason: string | null;
  additional_clinical_notes: string | null;
  created_at: string;
}

interface TreatmentPlanFollowUpProps {
  caseId: string;
  isOwner: boolean;
}

// Non-implementation reason options
const NON_IMPLEMENTATION_REASONS = [
  { value: 'low_evidence', label: 'Low level of evidence' },
  { value: 'similar_agent', label: 'Used similar agent' },
  { value: 'cost', label: 'Cost constraints' },
  { value: 'patient_unfit', label: 'Patient unfit for therapy' },
  { value: 'alternative_soc', label: 'Alternative standard of care exists' },
  { value: 'other', label: 'Other' },
];

const defaultFormData = {
  vmtb_discussion_date: '',
  participants: [] as string[],
  consensus_predominant_pathway: '',
  consensus_therapy_recommendation: '',
  amp_level_of_evidence: '',
  escat_level: '',
  overall_evidence_strength: '',
  is_treatment_implemented: null as boolean | null,
  treatment_initiation_date: '',
  treatment_discontinuation_date: '',
  treatment_administered: '',
  non_implementation_reason: '',
  non_implementation_other_text: '',
  alternative_treatment_plan: '',
};

// Auto-grow textarea handler
const handleTextareaAutoGrow = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
  const textarea = e.target;
  textarea.style.height = 'auto';
  textarea.style.height = `${textarea.scrollHeight}px`;
};

const defaultFollowUpForm = {
  followup_date: '',
  disease_progression_date: '',
  current_patient_status: '',
  discontinuation_or_ltfu_reason: '',
  additional_clinical_notes: '',
};

// Form state for a saved plan. 'other' reasons are stored as 'other:<text>'.
const planToFormData = (plan: TreatmentPlan) => {
  let reason = plan.non_implementation_reason || '';
  let otherText = '';
  if (reason.startsWith('other:')) {
    otherText = reason.substring(6);
    reason = 'other';
  }
  return {
    vmtb_discussion_date: plan.vmtb_discussion_date || '',
    participants: plan.participants || [],
    consensus_predominant_pathway: plan.consensus_predominant_pathway || '',
    consensus_therapy_recommendation: plan.consensus_therapy_recommendation || '',
    amp_level_of_evidence: plan.amp_level_of_evidence || '',
    escat_level: plan.escat_level || '',
    overall_evidence_strength: plan.overall_evidence_strength || '',
    is_treatment_implemented: plan.is_treatment_implemented,
    treatment_initiation_date: plan.treatment_initiation_date || '',
    treatment_discontinuation_date: plan.treatment_discontinuation_date || '',
    treatment_administered: plan.treatment_administered || '',
    non_implementation_reason: reason,
    non_implementation_other_text: otherText,
    alternative_treatment_plan: plan.alternative_treatment_plan || '',
  };
};

const sortFollowUps = (items: TreatmentFollowUp[]) =>
  [...items].sort((a, b) => a.followup_date.localeCompare(b.followup_date));

export function TreatmentPlanFollowUp({ caseId, isOwner }: TreatmentPlanFollowUpProps) {
  const [loading, setLoading] = useState(true);
  const [treatmentPlan, setTreatmentPlan] = useState<TreatmentPlan | null>(null);
  const [followUps, setFollowUps] = useState<TreatmentFollowUp[]>([]);
  const [formData, setFormData] = useState(defaultFormData);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [participantInput, setParticipantInput] = useState('');

  // Follow-up modal state
  const [showFollowUpModal, setShowFollowUpModal] = useState(false);
  const [followUpForm, setFollowUpForm] = useState(defaultFollowUpForm);
  const [editingFollowUpId, setEditingFollowUpId] = useState<string | null>(null);
  const [savingFollowUp, setSavingFollowUp] = useState(false);
  const [deleteFollowUpId, setDeleteFollowUpId] = useState<string | null>(null);
  const [deletingFollowUp, setDeletingFollowUp] = useState(false);

  const fetchData = async () => {
    setLoading(true);
    try {
      // Fetch treatment plan
      const { data: planData, error: planError } = await supabase
        .from('case_treatment_plans')
        .select('*')
        .eq('case_id', caseId)
        .maybeSingle();

      if (planError) throw planError;

      setTreatmentPlan(planData);

      if (planData) {
        setFormData(planToFormData(planData));

        // Fetch follow-ups
        console.log('Fetching follow-ups for treatment_plan_id:', planData.id);
        const { data: followUpsData, error: followUpsError } = await supabase
          .from('case_treatment_followups')
          .select('*')
          .eq('treatment_plan_id', planData.id)
          .order('followup_date', { ascending: true });

        console.log('Fetched follow-ups:', { followUpsData, followUpsError });
        if (followUpsError) throw followUpsError;
        setFollowUps(followUpsData || []);
      } else {
        setFormData(defaultFormData);
        setFollowUps([]);
      }
    } catch (err) {
      console.error('Failed to fetch treatment plan:', err);
      showToast.error('Failed to load treatment plan');
    } finally {
      setLoading(false);
    }
  };

  // Fetch treatment plan and follow-ups on mount and when caseId changes
  useEffect(() => {
    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseId]);

  const handleSave = async () => {
    if (!isOwner) return;

    // Validation
    if (!formData.vmtb_discussion_date) {
      showToast.error('vMTB Discussion Date is required');
      return;
    }
    if (formData.is_treatment_implemented === null) {
      showToast.error('Please select whether treatment was implemented');
      return;
    }
    // Validate NO path: reason is required
    if (formData.is_treatment_implemented === false) {
      if (!formData.non_implementation_reason) {
        showToast.error('Please select a reason for non-implementation');
        return;
      }
      // If "Other" is selected, the text is required
      if (formData.non_implementation_reason === 'other' && !formData.non_implementation_other_text.trim()) {
        showToast.error('Please specify the reason for "Other"');
        return;
      }
    }

    setSaving(true);
    try {
      // For 'other' reason, store as 'other:actual text'
      let reasonToStore = formData.non_implementation_reason;
      if (reasonToStore === 'other' && formData.non_implementation_other_text) {
        reasonToStore = `other:${formData.non_implementation_other_text}`;
      }

      const payload = {
        case_id: caseId,
        vmtb_discussion_date: formData.vmtb_discussion_date || null,
        participants: formData.participants.length > 0 ? formData.participants : null,
        consensus_predominant_pathway: formData.consensus_predominant_pathway || null,
        consensus_therapy_recommendation: formData.consensus_therapy_recommendation || null,
        amp_level_of_evidence: formData.amp_level_of_evidence || null,
        escat_level: formData.escat_level || null,
        overall_evidence_strength: formData.overall_evidence_strength || null,
        is_treatment_implemented: formData.is_treatment_implemented,
        // YES path fields
        treatment_initiation_date: formData.is_treatment_implemented ? (formData.treatment_initiation_date || null) : (!formData.is_treatment_implemented ? (formData.treatment_initiation_date || null) : null),
        treatment_discontinuation_date: formData.is_treatment_implemented ? (formData.treatment_discontinuation_date || null) : (!formData.is_treatment_implemented ? (formData.treatment_discontinuation_date || null) : null),
        treatment_administered: formData.is_treatment_implemented ? (formData.treatment_administered || null) : null,
        // NO path fields
        non_implementation_reason: !formData.is_treatment_implemented ? (reasonToStore || null) : null,
        non_implementation_notes: null, // No longer used
        alternative_treatment_plan: !formData.is_treatment_implemented ? (formData.alternative_treatment_plan || null) : null,
      };

      // The saved row comes back from the write, so the tab updates in place
      // instead of refetching and flashing its loading state.
      if (treatmentPlan) {
        // Update existing
        const { data, error } = await supabase
          .from('case_treatment_plans')
          .update(payload)
          .eq('id', treatmentPlan.id)
          .select()
          .single();

        if (error) throw error;
        setTreatmentPlan(data);
        setFormData(planToFormData(data));
        showToast.success('Treatment plan updated');
      } else {
        // Insert new
        const { data, error } = await supabase
          .from('case_treatment_plans')
          .insert(payload)
          .select()
          .single();

        if (error) throw error;
        setTreatmentPlan(data);
        setFormData(planToFormData(data));
        showToast.success('Treatment plan created');
      }

      setEditing(false);
    } catch (err) {
      console.error('Failed to save treatment plan:', err);
      showToast.error('Failed to save treatment plan');
    } finally {
      setSaving(false);
    }
  };

  const handleAddParticipant = () => {
    const trimmed = participantInput.trim();
    if (trimmed && !formData.participants.includes(trimmed)) {
      setFormData(prev => ({
        ...prev,
        participants: [...prev.participants, trimmed],
      }));
      setParticipantInput('');
    }
  };

  const handleRemoveParticipant = (participant: string) => {
    setFormData(prev => ({
      ...prev,
      participants: prev.participants.filter(p => p !== participant),
    }));
  };

  const handleParticipantKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddParticipant();
    }
  };

  // Follow-up handlers
  const openAddFollowUpModal = () => {
    setFollowUpForm(defaultFollowUpForm);
    setEditingFollowUpId(null);
    setShowFollowUpModal(true);
  };

  const openEditFollowUpModal = (followUp: TreatmentFollowUp) => {
    setFollowUpForm({
      followup_date: followUp.followup_date || '',
      disease_progression_date: followUp.disease_progression_date || '',
      current_patient_status: followUp.current_patient_status || '',
      discontinuation_or_ltfu_reason: followUp.discontinuation_or_ltfu_reason || '',
      additional_clinical_notes: followUp.additional_clinical_notes || '',
    });
    setEditingFollowUpId(followUp.id);
    setShowFollowUpModal(true);
  };

  const handleSaveFollowUp = async () => {
    if (!isOwner || !treatmentPlan) return;

    if (!followUpForm.followup_date) {
      showToast.error('Follow-up date is required');
      return;
    }

    setSavingFollowUp(true);
    try {
      const payload = {
        treatment_plan_id: treatmentPlan.id,
        followup_date: followUpForm.followup_date,
        disease_progression_date: followUpForm.disease_progression_date || null,
        current_patient_status: followUpForm.current_patient_status || null,
        discontinuation_or_ltfu_reason: followUpForm.discontinuation_or_ltfu_reason || null,
        additional_clinical_notes: followUpForm.additional_clinical_notes || null,
      };

      console.log('Saving follow-up with payload:', payload);

      if (editingFollowUpId) {
        const { data, error } = await supabase
          .from('case_treatment_followups')
          .update(payload)
          .eq('id', editingFollowUpId)
          .select();

        console.log('Update result:', { data, error });
        if (error) throw error;
        const updated = data?.[0];
        if (updated) {
          setFollowUps(prev => sortFollowUps(prev.map(f => (f.id === updated.id ? updated : f))));
        }
        showToast.success('Follow-up updated');
      } else {
        const { data, error } = await supabase
          .from('case_treatment_followups')
          .insert(payload)
          .select();

        console.log('Insert result:', { data, error });
        if (error) throw error;
        const inserted = data?.[0];
        if (inserted) {
          setFollowUps(prev => sortFollowUps([...prev, inserted]));
        }
        showToast.success('Follow-up added');
      }

      setShowFollowUpModal(false);
      setFollowUpForm(defaultFollowUpForm);
      setEditingFollowUpId(null);
    } catch (err: any) {
      console.error('Failed to save follow-up:', err);
      showToast.error(err?.message || 'Failed to save follow-up');
    } finally {
      setSavingFollowUp(false);
    }
  };

  const handleDeleteFollowUp = async () => {
    if (!isOwner || !deleteFollowUpId) return;

    setDeletingFollowUp(true);
    try {
      const { error } = await supabase
        .from('case_treatment_followups')
        .delete()
        .eq('id', deleteFollowUpId);

      if (error) throw error;
      setFollowUps(prev => prev.filter(f => f.id !== deleteFollowUpId));
      showToast.success('Follow-up deleted');
      setDeleteFollowUpId(null);
    } catch (err) {
      console.error('Failed to delete follow-up:', err);
      showToast.error('Failed to delete follow-up');
    } finally {
      setDeletingFollowUp(false);
    }
  };

  if (loading) {
    return (
      <div className="text-center py-8">
        <p className="text-text-muted">Loading treatment plan...</p>
      </div>
    );
  }

  // Non-owner and no treatment plan
  if (!isOwner && !treatmentPlan) {
    return (
      <div className="bg-surface rounded-xl shadow-sm border border-border p-8 text-center">
        <p className="text-text-muted">Treatment plan not yet created.</p>
      </div>
    );
  }

  const isEditing = editing || (!treatmentPlan && isOwner);
  const isReadOnly = !isOwner || !isEditing;

  return (
    <div className="space-y-6">
      {/* Treatment Plan Section */}
      <div className="bg-surface rounded-xl shadow-sm border border-border">
        <div data-tour="treatment-plan" className="px-6 py-4 border-b border-border flex items-center justify-between">
          <h3 className="text-lg font-semibold text-text-muted">Treatment Plan</h3>
          {isOwner && treatmentPlan && !editing && (
            <button
              onClick={() => setEditing(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-border rounded-lg text-text-muted hover:bg-bg transition-colors"
            >
              <Edit2 className="w-4 h-4" />
              Edit
            </button>
          )}
          {isOwner && isEditing && (
            <div className="flex items-center gap-2">
              {treatmentPlan && (
                <button
                  onClick={() => {
                    setEditing(false);
                    // Reset form to saved data
                    setFormData(planToFormData(treatmentPlan));
                  }}
                  className="px-3 py-1.5 text-sm border border-border rounded-lg text-text-muted hover:bg-bg transition-colors"
                >
                  Cancel
                </button>
              )}
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-primary-solid text-on-solid rounded-lg hover:bg-primary-solid-hover disabled:opacity-50 transition-colors"
              >
                <Save className="w-4 h-4" />
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          )}
        </div>

        <div className="p-6 space-y-6">
          {/* Section 1: vMTB Discussion Details */}
          <div className="space-y-4">
            <h4 className="text-base font-semibold text-text-muted border-b border-border pb-2">
              Section 1: vMTB Discussion Details
            </h4>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-text-muted mb-1">
                  vMTB Discussion Date <span className="text-danger">*</span>
                </label>
                <input
                  type="date"
                  value={formData.vmtb_discussion_date}
                  onChange={(e) => setFormData(prev => ({ ...prev, vmtb_discussion_date: e.target.value }))}
                  disabled={isReadOnly}
                  className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary disabled:bg-bg disabled:text-text-muted"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-text-muted mb-1">Participants</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={participantInput}
                    onChange={(e) => setParticipantInput(e.target.value)}
                    onKeyDown={handleParticipantKeyDown}
                    disabled={isReadOnly}
                    placeholder="Add participant and press Enter"
                    className="flex-1 px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary disabled:bg-bg disabled:text-text-muted"
                  />
                  {!isReadOnly && (
                    <button
                      type="button"
                      onClick={handleAddParticipant}
                      className="px-3 py-2 bg-surface-muted border border-border rounded-lg text-sm hover:bg-border transition-colors"
                    >
                      Add
                    </button>
                  )}
                </div>
                {formData.participants.length > 0 && (
                  <div className="flex flex-wrap gap-2 mt-2">
                    {formData.participants.map((p, idx) => (
                      <span key={idx} className="inline-flex items-center gap-1 px-2 py-1 bg-info-bg-strong text-info-text text-xs rounded-full">
                        {p}
                        {!isReadOnly && (
                          <button
                            type="button"
                            onClick={() => handleRemoveParticipant(p)}
                            className="hover:text-info"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        )}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-text-muted mb-1">Consensus Predominant Pathway</label>
              <textarea
                value={formData.consensus_predominant_pathway}
                onChange={(e) => {
                  setFormData(prev => ({ ...prev, consensus_predominant_pathway: e.target.value }));
                  handleTextareaAutoGrow(e);
                }}
                disabled={isReadOnly}
                rows={2}
                className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary disabled:bg-bg disabled:text-text-muted resize-y min-h-[60px]"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-text-muted mb-1">Consensus Therapy Recommendation</label>
              <textarea
                value={formData.consensus_therapy_recommendation}
                onChange={(e) => {
                  setFormData(prev => ({ ...prev, consensus_therapy_recommendation: e.target.value }));
                  handleTextareaAutoGrow(e);
                }}
                disabled={isReadOnly}
                rows={2}
                className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary disabled:bg-bg disabled:text-text-muted resize-y min-h-[60px]"
              />
            </div>
          </div>

          {/* Section 2: Evidence Evaluation */}
          <div className="space-y-4">
            <h4 className="text-base font-semibold text-text-muted border-b border-border pb-2">
              Section 2: Evidence Evaluation
            </h4>
            
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-text-muted mb-1">AMP Level of Evidence</label>
                <select
                  value={formData.amp_level_of_evidence}
                  onChange={(e) => setFormData(prev => ({ ...prev, amp_level_of_evidence: e.target.value }))}
                  disabled={isReadOnly}
                  className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary disabled:bg-bg disabled:text-text-muted"
                >
                  <option value="">Select...</option>
                  <option value="Tier I - Level A">Tier I - Level A</option>
                  <option value="Tier I - Level B">Tier I - Level B</option>
                  <option value="Tier II - Level C">Tier II - Level C</option>
                  <option value="Tier II - Level D">Tier II - Level D</option>
                  <option value="Tier III">Tier III</option>
                  <option value="Tier IV">Tier IV</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-text-muted mb-1">ESCAT Level</label>
                <select
                  value={formData.escat_level}
                  onChange={(e) => setFormData(prev => ({ ...prev, escat_level: e.target.value }))}
                  disabled={isReadOnly}
                  className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary disabled:bg-bg disabled:text-text-muted"
                >
                  <option value="">Select...</option>
                  <option value="ESCAT I">ESCAT I</option>
                  <option value="ESCAT II">ESCAT II</option>
                  <option value="ESCAT III">ESCAT III</option>
                  <option value="ESCAT IV">ESCAT IV</option>
                  <option value="ESCAT X">ESCAT X</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-text-muted mb-1">Overall Evidence Strength</label>
                <select
                  value={formData.overall_evidence_strength}
                  onChange={(e) => setFormData(prev => ({ ...prev, overall_evidence_strength: e.target.value }))}
                  disabled={isReadOnly}
                  className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary disabled:bg-bg disabled:text-text-muted"
                >
                  <option value="">Select...</option>
                  <option value="Strong">Strong</option>
                  <option value="Moderate">Moderate</option>
                  <option value="Weak">Weak</option>
                  <option value="Insufficient">Insufficient</option>
                </select>
              </div>
            </div>
          </div>

          {/* Section 3: Treatment Implementation */}
          <div className="space-y-4">
            <h4 className="text-base font-semibold text-text-muted border-b border-border pb-2">
              Section 3: Treatment Implementation
            </h4>
            
            <div>
              <label className="block text-sm font-medium text-text-muted mb-2">
                Was the vMTB-Recommended Treatment Plan Implemented? <span className="text-danger">*</span>
              </label>
              <div className="flex items-center gap-6">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="is_treatment_implemented"
                    checked={formData.is_treatment_implemented === true}
                    onChange={() => setFormData(prev => ({ 
                      ...prev, 
                      is_treatment_implemented: true,
                      // Clear NO-related fields
                      non_implementation_reason: '',
                      non_implementation_other_text: '',
                      alternative_treatment_plan: '',
                    }))}
                    disabled={isReadOnly}
                    className="w-4 h-4 text-primary border-border focus:ring-primary"
                  />
                  <span className="text-sm text-text-muted">Yes</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="is_treatment_implemented"
                    checked={formData.is_treatment_implemented === false}
                    onChange={() => setFormData(prev => ({ 
                      ...prev, 
                      is_treatment_implemented: false,
                      // Clear YES-related fields
                      treatment_initiation_date: '',
                      treatment_discontinuation_date: '',
                      treatment_administered: '',
                    }))}
                    disabled={isReadOnly}
                    className="w-4 h-4 text-primary border-border focus:ring-primary"
                  />
                  <span className="text-sm text-text-muted">No</span>
                </label>
              </div>
            </div>

            {/* YES fields */}
            {formData.is_treatment_implemented === true && (
              <div className="pl-4 border-l-2 border-success-border space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-text-muted mb-1">Date of Treatment Initiation</label>
                    <input
                      type="date"
                      value={formData.treatment_initiation_date}
                      onChange={(e) => setFormData(prev => ({ ...prev, treatment_initiation_date: e.target.value }))}
                      disabled={isReadOnly}
                      className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary disabled:bg-bg disabled:text-text-muted"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-text-muted mb-1">Date of Treatment Discontinuation (optional)</label>
                    <input
                      type="date"
                      value={formData.treatment_discontinuation_date}
                      onChange={(e) => setFormData(prev => ({ ...prev, treatment_discontinuation_date: e.target.value }))}
                      disabled={isReadOnly}
                      className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary disabled:bg-bg disabled:text-text-muted"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-text-muted mb-1">Treatment Administered</label>
                  <textarea
                    value={formData.treatment_administered}
                    onChange={(e) => {
                      setFormData(prev => ({ ...prev, treatment_administered: e.target.value }));
                      handleTextareaAutoGrow(e);
                    }}
                    disabled={isReadOnly}
                    rows={3}
                    placeholder="Describe the treatment administered..."
                    className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary disabled:bg-bg disabled:text-text-muted resize-y min-h-[80px]"
                  />
                </div>
              </div>
            )}

            {/* NO fields */}
            {formData.is_treatment_implemented === false && (
              <div className="pl-4 border-l-2 border-danger-border space-y-4">
                <div>
                  <label className="block text-sm font-medium text-text-muted mb-2">Reason for Non-Implementation</label>
                  <div className="space-y-2">
                    {NON_IMPLEMENTATION_REASONS.map((option) => (
                      <div key={option.value} className="flex items-start gap-2">
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="radio"
                            name="non_implementation_reason"
                            value={option.value}
                            checked={formData.non_implementation_reason === option.value}
                            onChange={() => setFormData(prev => ({ 
                              ...prev, 
                              non_implementation_reason: option.value,
                              non_implementation_other_text: option.value !== 'other' ? '' : prev.non_implementation_other_text,
                            }))}
                            disabled={isReadOnly}
                            className="w-4 h-4 text-primary border-border focus:ring-primary mt-0.5"
                          />
                          <span className="text-sm text-text-muted">{option.label}</span>
                        </label>
                        {/* Inline text input for Other */}
                        {option.value === 'other' && formData.non_implementation_reason === 'other' && (
                          <input
                            type="text"
                            value={formData.non_implementation_other_text}
                            onChange={(e) => setFormData(prev => ({ ...prev, non_implementation_other_text: e.target.value }))}
                            disabled={isReadOnly}
                            placeholder="Please specify..."
                            className="flex-1 ml-2 px-2 py-1 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary disabled:bg-bg disabled:text-text-muted"
                            required
                          />
                        )}
                      </div>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-text-muted mb-1">Alternative Treatment Plan Used</label>
                  <textarea
                    value={formData.alternative_treatment_plan}
                    onChange={(e) => {
                      setFormData(prev => ({ ...prev, alternative_treatment_plan: e.target.value }));
                      handleTextareaAutoGrow(e);
                    }}
                    disabled={isReadOnly}
                    rows={3}
                    placeholder="Describe alternative treatment..."
                    className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary disabled:bg-bg disabled:text-text-muted resize-y min-h-[80px]"
                  />
                </div>
                {/* Date fields for NO path */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-text-muted mb-1">Date of Treatment Initiation in Clinical Practice</label>
                    <input
                      type="date"
                      value={formData.treatment_initiation_date}
                      onChange={(e) => setFormData(prev => ({ ...prev, treatment_initiation_date: e.target.value }))}
                      disabled={isReadOnly}
                      className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary disabled:bg-bg disabled:text-text-muted"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-text-muted mb-1">Date of Treatment Discontinuation (optional)</label>
                    <input
                      type="date"
                      value={formData.treatment_discontinuation_date}
                      onChange={(e) => setFormData(prev => ({ ...prev, treatment_discontinuation_date: e.target.value }))}
                      disabled={isReadOnly}
                      className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary disabled:bg-bg disabled:text-text-muted"
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Follow-Up Section */}
      <div className="bg-surface rounded-xl shadow-sm border border-border">
        <div className="px-6 py-4 border-b border-border flex items-center justify-between">
          <h3 className="text-lg font-semibold text-text-muted">Follow-Ups</h3>
          {isOwner && treatmentPlan && (
            <button
              onClick={openAddFollowUpModal}
              data-tour="add-follow-up"
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-primary-solid text-on-solid rounded-lg hover:bg-primary-solid-hover transition-colors"
            >
              <Plus className="w-4 h-4" />
              Add Follow-Up
            </button>
          )}
        </div>

        <div className="p-6">
          {!treatmentPlan ? (
            <p className="text-sm text-text-muted text-center py-4">
              {isOwner ? 'Save the treatment plan first to add follow-ups.' : 'No treatment plan exists yet.'}
            </p>
          ) : followUps.length === 0 ? (
            <p className="text-sm text-text-muted text-center py-4">No follow-ups documented yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left py-3 px-2 font-medium text-text-muted">Follow-up Date</th>
                    <th className="text-left py-3 px-2 font-medium text-text-muted">Disease Progression Date</th>
                    <th className="text-left py-3 px-2 font-medium text-text-muted">Patient Status</th>
                    <th className="text-left py-3 px-2 font-medium text-text-muted">Discontinuation/LTFU</th>
                    <th className="text-left py-3 px-2 font-medium text-text-muted">Notes</th>
                    {isOwner && <th className="text-right py-3 px-2 font-medium text-text-muted">Actions</th>}
                  </tr>
                </thead>
                <tbody>
                  {followUps.map((fu) => (
                    <tr key={fu.id} className="border-b border-border hover:bg-bg">
                      <td className="py-3 px-2">{fu.followup_date || '-'}</td>
                      <td className="py-3 px-2">{fu.disease_progression_date || '-'}</td>
                      <td className="py-3 px-2">
                        {fu.current_patient_status ? (
                          <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${
                            fu.current_patient_status === 'Alive' 
                              ? 'bg-success-bg-strong text-success-text' 
                              : 'bg-surface-muted text-text'
                          }`}>
                            {fu.current_patient_status}
                          </span>
                        ) : '-'}
                      </td>
                      <td className="py-3 px-2 max-w-[150px] truncate" title={fu.discontinuation_or_ltfu_reason || ''}>
                        {fu.discontinuation_or_ltfu_reason || '-'}
                      </td>
                      <td className="py-3 px-2 max-w-[200px] truncate" title={fu.additional_clinical_notes || ''}>
                        {fu.additional_clinical_notes || '-'}
                      </td>
                      {isOwner && (
                        <td className="py-3 px-2 text-right">
                          <div className="flex items-center justify-end gap-2">
                            <button
                              onClick={() => openEditFollowUpModal(fu)}
                              className="p-1 text-text-muted hover:text-info transition-colors"
                              title="Edit"
                            >
                              <Edit2 className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => setDeleteFollowUpId(fu.id)}
                              className="p-1 text-text-muted hover:text-danger transition-colors"
                              title="Delete"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Add/Edit Follow-Up Modal */}
      <Modal
        isOpen={showFollowUpModal}
        onClose={() => {
          setShowFollowUpModal(false);
          setFollowUpForm(defaultFollowUpForm);
          setEditingFollowUpId(null);
        }}
        title={editingFollowUpId ? 'Edit Follow-Up' : 'Add Follow-Up'}
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-text-muted mb-1">
              Follow-up Date <span className="text-danger">*</span>
            </label>
            <input
              type="date"
              value={followUpForm.followup_date}
              onChange={(e) => setFollowUpForm(prev => ({ ...prev, followup_date: e.target.value }))}
              className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-text-muted mb-1">Disease Progression Date</label>
            <input
              type="date"
              value={followUpForm.disease_progression_date}
              onChange={(e) => setFollowUpForm(prev => ({ ...prev, disease_progression_date: e.target.value }))}
              className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-text-muted mb-1">Current Patient Status</label>
            <select
              value={followUpForm.current_patient_status}
              onChange={(e) => setFollowUpForm(prev => ({ ...prev, current_patient_status: e.target.value }))}
              className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary"
            >
              <option value="">Select...</option>
              <option value="Alive">Alive</option>
              <option value="Deceased">Deceased</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-text-muted mb-1">Reason for Discontinuation / LTFU</label>
            <input
              type="text"
              value={followUpForm.discontinuation_or_ltfu_reason}
              onChange={(e) => setFollowUpForm(prev => ({ ...prev, discontinuation_or_ltfu_reason: e.target.value }))}
              className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-text-muted mb-1">Additional Notes</label>
            <textarea
              value={followUpForm.additional_clinical_notes}
              onChange={(e) => {
                setFollowUpForm(prev => ({ ...prev, additional_clinical_notes: e.target.value }));
                handleTextareaAutoGrow(e);
              }}
              rows={3}
              className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary resize-y min-h-[80px]"
            />
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button
              onClick={() => {
                setShowFollowUpModal(false);
                setFollowUpForm(defaultFollowUpForm);
                setEditingFollowUpId(null);
              }}
              disabled={savingFollowUp}
              className="px-4 py-2 border border-border rounded-lg text-text-muted hover:bg-bg transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={handleSaveFollowUp}
              disabled={savingFollowUp}
              className="px-4 py-2 bg-primary-solid text-on-solid rounded-lg hover:bg-primary-solid-hover transition-colors disabled:opacity-50"
            >
              {savingFollowUp ? 'Saving...' : editingFollowUpId ? 'Update' : 'Add'}
            </button>
          </div>
        </div>
      </Modal>

      {/* Delete Follow-Up Confirmation Modal */}
      <Modal
        isOpen={!!deleteFollowUpId}
        onClose={() => setDeleteFollowUpId(null)}
        title="Delete Follow-Up"
      >
        <div className="space-y-4">
          <p className="text-sm text-text-muted">
            Are you sure you want to delete this follow-up? This action cannot be undone.
          </p>
          <div className="flex justify-end gap-3">
            <button
              onClick={() => setDeleteFollowUpId(null)}
              disabled={deletingFollowUp}
              className="px-4 py-2 border border-border rounded-lg text-text-muted hover:bg-bg transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={handleDeleteFollowUp}
              disabled={deletingFollowUp}
              className="px-4 py-2 bg-danger-solid text-on-solid rounded-lg hover:bg-danger-solid-hover transition-colors disabled:opacity-50"
            >
              {deletingFollowUp ? 'Deleting...' : 'Delete'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
